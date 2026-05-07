/**
 * Background worker for the discovered_contacts review queue.
 *
 * Two responsibilities, both running every 5 minutes (via the campaign
 * scheduler tick that registers this job in server.ts):
 *
 *   1. Verify pending email candidates through the existing layered email
 *      validator (ZeroBounce → MillionVerifier → Hunter cascade) so the
 *      Prospects review queue surfaces verdicts without burning credits on
 *      candidates the user hasn't seen yet — except we DO verify before the
 *      user sees them so the Accept button can immediately promote a
 *      verified-valid candidate without a second blocking call.
 *
 *   2. Scrape pending URL candidates through scrape_website.py to harvest
 *      any contact emails the partner-brand site exposes. Harvested emails
 *      become their own kind='email' rows so they go through the same
 *      verification + accept flow.
 *
 * Capped per tick to keep verification credits and Playwright spawns
 * predictable. Exits early when nothing is pending so most ticks are no-ops.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { config } from '../config.js';
import {
  listUnprocessed,
  setVerificationStatus,
  setScrapeResult,
  insertDiscoveredContact,
  type DiscoveredContact,
} from '../db/discovered-contacts.js';
import { validateEmail } from '../services/email-validator/index.js';

// Per-tick caps. Verifier cap is the big lever — burning 50 credits in a
// single tick on a flood of auto-replies isn't useful. Scrape cap is bounded
// by Playwright spawn cost.
const VERIFY_PER_TICK = 10;
const SCRAPE_PER_TICK = 3;

let running = false;

export async function processDiscoveredContacts(): Promise<{ verified: number; scraped: number; harvested: number }> {
  // Reentrancy guard — if a previous tick is still running (e.g. slow
  // verifier round-trip), skip rather than overlap.
  if (running) return { verified: 0, scraped: 0, harvested: 0 };
  running = true;

  let verified = 0;
  let scraped = 0;
  let harvested = 0;

  try {
    verified = await verifyPendingEmails();
    const scrapeResult = await scrapePendingUrls();
    scraped = scrapeResult.scraped;
    harvested = scrapeResult.harvested;
  } catch (e) {
    console.error('[discovered-contacts] worker error:', e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }

  return { verified, scraped, harvested };
}

async function verifyPendingEmails(): Promise<number> {
  const rows = await listUnprocessed({ kind: 'email', limit: VERIFY_PER_TICK });
  if (rows.length === 0) return 0;

  let count = 0;
  for (const row of rows) {
    try {
      const result = await validateEmail(row.value);
      await setVerificationStatus(row.id, result.status);
      count++;
      console.log(`[discovered-contacts] verified ${row.value} → ${result.status} (via ${result.sourceStage})`);
    } catch (e) {
      console.warn(`[discovered-contacts] validate(${row.value}) failed:`, e instanceof Error ? e.message : e);
      // Don't mark failures with a verdict — leaving verification_status null
      // means the worker will retry on the next tick.
    }
  }
  return count;
}

async function scrapePendingUrls(): Promise<{ scraped: number; harvested: number }> {
  const rows = await listUnprocessed({ kind: 'url', limit: SCRAPE_PER_TICK });
  if (rows.length === 0) return { scraped: 0, harvested: 0 };

  let scraped = 0;
  let harvested = 0;

  for (const row of rows) {
    try {
      const scrape = await scrapeUrl(row.value);
      // Persist whatever the scraper returned (even if no email was found —
      // company_name and screenshot_path may still be useful for the spawn flow).
      await setScrapeResult(row.id, scrape);
      scraped++;
      console.log(`[discovered-contacts] scraped ${row.value} → email=${scrape.website_email ?? 'none'}`);

      // Harvest any contact email into its own kind='email' row so the user
      // can accept it like any other candidate. Inherits the parent's
      // metadata so the audit trail back to the original auto-reply is intact.
      const email = scrape.website_email as string | undefined;
      if (email) {
        await insertDiscoveredContact({
          lead_id: row.lead_id,
          source_campaign_lead_id: row.source_campaign_lead_id,
          kind: 'email',
          value: email,
          role: 'harvested',
          score: row.score,                  // inherits the URL's score so high-signal partner pages float their emails to the top
          auto_reply_message_id: row.auto_reply_message_id,
          auto_reply_metadata: {
            ...(row.auto_reply_metadata ?? {}),
            harvested_from_url: row.value,
            company_name: scrape.company_name ?? null,
            screenshot_path: scrape.screenshot_path ?? null,
          },
        });
        harvested++;
      }
    } catch (e) {
      console.warn(`[discovered-contacts] scrape(${row.value}) failed:`, e instanceof Error ? e.message : e);
      // Persist an empty scrape_result so we don't retry forever on a broken URL.
      await setScrapeResult(row.id, { error: e instanceof Error ? e.message : String(e), attempted_at: new Date().toISOString() });
    }
  }
  return { scraped, harvested };
}

/**
 * Invoke tools/scraper/scrape_website.py for a single URL.
 *
 * The Python script processes a JSON list of leads with a website_url field
 * and writes the enriched result back. We adapt it to single-URL discovery
 * by writing a one-row temp file, spawning the script, then reading the
 * mutated row.
 */
async function scrapeUrl(url: string): Promise<Record<string, unknown>> {
  const tmpDir = path.resolve(config.projectRoot, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const inputPath = path.join(tmpDir, `discovery-scrape-${stamp}.json`);

  const targetUrl = url.startsWith('http') ? url : `https://${url}`;
  const seedRow = {
    id: `discovery-${stamp}`,
    company_name: extractCompanyFromUrl(targetUrl),
    website_url: targetUrl,
  };

  fs.writeFileSync(inputPath, JSON.stringify([seedRow]), { encoding: 'utf-8' });

  const scriptPath = path.resolve(config.projectRoot, 'tools', 'scraper', 'scrape_website.py');
  const args = ['--input', inputPath, '--output', inputPath, '--parallel', '1'];

  const exitCode = await runPython(scriptPath, args);

  let result: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(inputPath, 'utf-8');
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (Array.isArray(parsed) && parsed.length > 0) result = parsed[0];
  } catch (e) {
    console.warn('[discovered-contacts] failed to read scrape result:', e instanceof Error ? e.message : e);
  } finally {
    try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
  }

  if (exitCode !== 0 && !result.website_email) {
    throw new Error(`scrape_website.py exited ${exitCode}`);
  }

  return {
    website_email: result.website_email ?? null,
    company_name: result.company_name ?? null,
    screenshot_path: result.screenshot_path ?? null,
    scraped_at: new Date().toISOString(),
  };
}

function runPython(scriptPath: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(config.pythonPath, [scriptPath, ...args], {
      cwd: config.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      // Forward progress lines for parity with scrape-runner logs
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[discovered-contacts][scrape] ${line.trim()}`);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.trim()) console.warn(`[discovered-contacts][scrape:err] ${line.trim()}`);
      }
    });

    // Hard cap: a single URL scrape should never take more than 90s. Kill
    // and resolve with a non-zero code so the worker treats it as a failure
    // and persists an error so we don't retry indefinitely.
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
        } else {
          proc.kill('SIGKILL');
        }
      } catch { /* ignore */ }
    }, 90_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
  });
}

function extractCompanyFromUrl(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    return url;
  }
}

// Provide a no-op import-side effect for environments that try to read os —
// the variable above prevents tree-shaking complaints if we add temp-dir
// logic later.
void os;

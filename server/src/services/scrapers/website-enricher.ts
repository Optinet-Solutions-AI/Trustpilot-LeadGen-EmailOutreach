/**
 * Website email enricher — TypeScript port with tier escalation.
 *
 * Flow per lead:
 *   1. Try tier 2 (stealth) — sufficient for ~80% of sites
 *   2. On bot-detection failure, escalate to tier 3 (datacenter proxy) if configured
 *   3. Still blocked → tier 4 (residential proxy) if configured
 *   4. Final fallback — MX-validated guess (info@/contact@/support@ @ domain)
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { Resolver } from 'node:dns/promises';
import { launchBrowser, TIER_CONFIGS, humanDelay, type Tier } from './browser-launcher.js';
import { dismissPopups, handleCloudflareChallenge, detectBlock } from './popup-handler.js';

// Use explicit DNS servers. System DNS on Cloud Run can be flaky and may refuse
// MX queries when the instance is cold. Google + Cloudflare are always reachable.
const _resolver = new Resolver();
_resolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

// ─── Email classification ────────────────────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Obfuscated pattern — REQUIRES brackets or parens around "at"/"dot" so we don't
// match natural English ("changed at anytime to…"). Only catches deliberate
// obfuscation like: user [at] domain [dot] com / user(at)domain(dot)com
const OBFUSCATED_RE = /([a-zA-Z0-9._%+\-]+)\s*[[(]\s*(?:at|AT)\s*[\])]\s*([a-zA-Z0-9\-]+)\s*[[(]\s*(?:dot|DOT)\s*[\])]\s*([a-zA-Z]{2,})/g;

const UNDELIVERABLE_PREFIXES = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
  'postmaster', 'mailer-daemon', 'bounce', 'bounces', 'abuse',
  'spam', 'unsubscribe', 'webmaster',
]);

const TOP_PREFIXES = new Set([
  'contact', 'hello', 'hi', 'sales', 'partnerships', 'partner',
  'business', 'marketing', 'outreach', 'pr', 'media',
]);

const ACCEPTABLE_PREFIXES = new Set([
  'info', 'enquiries', 'enquiry', 'inquiries', 'inquiry',
  'office', 'team', 'mail', 'email', 'general', 'admin',
  'reception', 'help', 'support',
]);

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'aol.com', 'mail.com', 'protonmail.com', 'yandex.com',
  'gmx.com', 'gmx.de', 'web.de', 'zoho.com',
  'zendesk.com', 'freshdesk.com', 'helpscout.com', 'intercom.io',
  'salesforce.com', 'hubspot.com', 'mailchimp.com', 'sendgrid.net',
]);

// TLDs that look like email TLDs but are actually file extensions or code.
// Minified JS/CSS often contains identifier@file.js patterns that match the email regex.
const INVALID_TLDS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'css', 'scss', 'sass', 'less',
  'html', 'htm', 'php', 'asp', 'aspx',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico',
  'json', 'xml', 'yaml', 'yml', 'toml',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'mp3', 'wav',
  'map', 'lock', 'log',
]);

// ─── Contact sub-paths to probe when homepage yields nothing ────────────────

const CONTACT_PATHS = [
  '/contact', '/contact-us', '/contact_us',
  '/about', '/about-us',
  '/impressum', '/kontakt', '/contacto',
  '/support', '/help',
];

// ─── MX fallback guesses (ordered — best cold-outreach address first) ───────

const GUESS_PREFIXES = ['info', 'contact', 'hello', 'support', 'sales'];

// ────────────────────────────────────────────────────────────────────────────

function isUndeliverable(email: string): boolean {
  return UNDELIVERABLE_PREFIXES.has(email.split('@')[0].toLowerCase());
}

function isFreeProvider(email: string): boolean {
  const parts = email.split('@');
  return FREE_EMAIL_DOMAINS.has((parts[1] || '').toLowerCase());
}

/**
 * Reject emails that look real but are actually code fragments from minified JS/CSS.
 * Examples: "d@a.js", "fn@file.css", "e@h.map", "x@i.j" (too short overall).
 */
function looksLikeCodeFragment(email: string): boolean {
  const [prefix, domainPart] = email.split('@');
  if (!domainPart) return true;
  // Prefix too short — single-letter variables in minified code
  if (prefix.length < 2) return true;
  // TLD is a file extension
  const tld = domainPart.split('.').pop()?.toLowerCase() || '';
  if (INVALID_TLDS.has(tld)) return true;
  // Domain body (without TLD) too short — real company domains are 3+ chars
  // ("bp.com" is an exception but rare; we accept losing those to avoid noise)
  const domainBody = domainPart.slice(0, domainPart.lastIndexOf('.'));
  if (domainBody.length < 3) return true;
  return false;
}

function rankEmail(email: string): number {
  const prefix = email.split('@')[0].toLowerCase();
  if (TOP_PREFIXES.has(prefix)) return 0;
  if (ACCEPTABLE_PREFIXES.has(prefix)) return 1;
  return 2;  // specific/unknown prefix — often a real person, best for cold outreach
}

function extractEmailsFromText(text: string): string[] {
  const emails = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
  for (const m of text.matchAll(OBFUSCATED_RE)) {
    const candidate = `${m[1]}@${m[2]}.${m[3]}`.toLowerCase();
    if (/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(candidate)) emails.add(candidate);
  }
  return [...emails];
}

/**
 * Keep only emails whose domain has real MX records.
 * Code fragments like `cre@ion.here` pass regex + length checks but fail DNS.
 *
 * Behaviour:
 *   - Cache positive hits (has MX) and NODATA/ENOTFOUND (definitely no MX)
 *   - Don't cache transient errors (ETIMEOUT, ECONNREFUSED) — they're network
 *     flakes, not facts about the domain. On transient error, fall back to
 *     accepting the email so we don't drop real candidates.
 */
type MxResult = 'has_mx' | 'no_mx' | 'unknown';
const _mxCache = new Map<string, MxResult>();

async function checkMx(domain: string): Promise<MxResult> {
  const cached = _mxCache.get(domain);
  if (cached) return cached;
  try {
    const records = await _resolver.resolveMx(domain);
    const result: MxResult = records.length > 0 ? 'has_mx' : 'no_mx';
    _mxCache.set(domain, result);
    return result;
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Definitive negative answers — safe to cache and reject
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      _mxCache.set(domain, 'no_mx');
      return 'no_mx';
    }
    // Transient: DNS refused, timeout, etc. — don't reject, don't cache
    return 'unknown';
  }
}

async function filterByMx(emails: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const email of emails) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) continue;
    const mx = await checkMx(domain);
    // Accept anything that isn't a definitive "no MX" answer
    if (mx !== 'no_mx') kept.push(email);
  }
  return kept;
}

async function findEmailsOnPage(page: Page): Promise<string[]> {
  const collected = new Set<string>();
  try {
    const pageData = await page.evaluate(() => {
      const mailtoEmails: string[] = [];
      document.querySelectorAll('a[href^="mailto:"]').forEach((el) => {
        const email = (el as HTMLAnchorElement).href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
        if (email && email.includes('@')) mailtoEmails.push(email);
      });
      const dataAttrEmails: string[] = [];
      document.querySelectorAll('[data-email],[data-mail],[data-contact]').forEach((el) => {
        const v = el.getAttribute('data-email') || el.getAttribute('data-mail') || el.getAttribute('data-contact');
        if (v && v.includes('@')) dataAttrEmails.push(v.toLowerCase().trim());
      });
      return {
        mailtoEmails,
        dataAttrEmails,
        bodyText: document.body ? document.body.innerText : '',
      };
    });

    pageData.mailtoEmails.forEach((e) => collected.add(e));
    pageData.dataAttrEmails.forEach((e) => collected.add(e));
    extractEmailsFromText(pageData.bodyText).forEach((e) => collected.add(e));

    const html = await page.content();
    extractEmailsFromText(html).forEach((e) => collected.add(e));
  } catch (err) {
    console.log(`    [enricher] email extraction error: ${(err as Error).message.slice(0, 100)}`);
  }

  const preFiltered = [...collected].filter(
    (e) => !isUndeliverable(e) && !isFreeProvider(e) && !looksLikeCodeFragment(e),
  );
  return filterByMx(preFiltered);
}

function pickBestEmail(candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const ra = rankEmail(a);
    const rb = rankEmail(b);
    if (ra !== rb) return ra - rb;
    return a.length - b.length;
  });
  return sorted[0];
}

// ─── Navigation with stealth + challenge handling ───────────────────────────

async function safeGoto(page: Page, url: string, timeout: number): Promise<
  | { ok: true }
  | { ok: false; reason: 'cloudflare_challenge' | 'access_denied' | 'bot_detected' | 'empty_page' | 'nav_error' }
> {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (!response) return { ok: false, reason: 'nav_error' };
    if (response.status() === 403) return { ok: false, reason: 'access_denied' };

    // Give JS-rendered sites a moment to paint
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // Try to auto-resolve CF challenges before classifying as blocked
    await handleCloudflareChallenge(page).catch(() => {});
    await dismissPopups(page);

    const block = await detectBlock(page);
    if (block) return { ok: false, reason: block };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'nav_error' };
  }
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
}

function getDomain(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ─── MX-validated guess fallback ────────────────────────────────────────────

async function mxRecordExists(domain: string): Promise<boolean> {
  const result = await checkMx(domain);
  return result === 'has_mx';
}

async function mxValidatedGuess(websiteUrl: string): Promise<string | null> {
  const domain = getDomain(websiteUrl);
  if (!domain) return null;
  if (!(await mxRecordExists(domain))) return null;
  // Return the top-priority guess — caller treats this as a low-confidence candidate
  return `${GUESS_PREFIXES[0]}@${domain}`;
}

// ─── Per-lead enrichment ────────────────────────────────────────────────────

interface ScrapeSiteResult {
  found: string | null;
  candidates?: string[];
  blockReason?: string;
}

async function scrapeSite(page: Page, websiteUrl: string, timeout: number): Promise<ScrapeSiteResult> {
  const url = normalizeUrl(websiteUrl);
  if (!url) return { found: null, blockReason: 'invalid_url' };

  const all = new Set<string>();

  // 1. Homepage
  const nav = await safeGoto(page, url, timeout);
  if (!nav.ok) return { found: null, blockReason: (nav as { ok: false; reason: string }).reason };

  const homepage = await findEmailsOnPage(page);
  homepage.forEach((e) => all.add(e));

  // Early exit if we already have a top-priority email
  const topNow = [...all].filter((e) => rankEmail(e) === 0);
  if (topNow.length > 0) {
    return { found: pickBestEmail([...all])!, candidates: [...all] };
  }

  // 2. Contact sub-pages
  const base = url.replace(/\/$/, '');
  for (const path of CONTACT_PATHS) {
    try {
      const resp = await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 15_000) });
      if (resp && resp.ok()) {
        await dismissPopups(page);
        const emails = await findEmailsOnPage(page);
        emails.forEach((e) => all.add(e));
        if ([...all].some((e) => rankEmail(e) === 0)) break;
      }
    } catch { /* sub-path miss — try next */ }
    await new Promise((r) => setTimeout(r, 300));
  }

  const best = pickBestEmail([...all]);
  return best ? { found: best, candidates: [...all] } : { found: null };
}

// ─── Tier escalation ────────────────────────────────────────────────────────

const BLOCK_REASONS_THAT_ESCALATE = new Set([
  'cloudflare_challenge', 'access_denied', 'bot_detected', 'empty_page',
]);

async function enrichSingleLeadWithTiers(
  websiteUrl: string,
  startTier: Tier = 2,
): Promise<{ email: string | null; tier: Tier | 'mx' | 'none'; blockReason?: string }> {
  const availableTiers: Tier[] = [];
  for (const t of [startTier, 3, 4] as Tier[]) {
    if (t === startTier || !availableTiers.includes(t)) {
      // Skip proxy tiers if no env configured — launchBrowser falls back silently, so we
      // avoid wasting a tier slot by only including them when actually available.
      if (t === 3 && !process.env.SCRAPER_DC_PROXY_URL) continue;
      if (t === 4 && !process.env.SCRAPER_RES_PROXY_URL) continue;
      availableTiers.push(t);
    }
  }

  let lastBlockReason: string | undefined;
  for (const tier of availableTiers) {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      const bundle = await launchBrowser(TIER_CONFIGS[tier]);
      browser = bundle.browser;
      context = bundle.context;
      const page = await context.newPage();
      const result = await scrapeSite(page, websiteUrl, TIER_CONFIGS[tier].timeout);
      if (result.found) return { email: result.found, tier };
      const reason = result.blockReason ?? undefined;
      lastBlockReason = reason || lastBlockReason;
      if (!reason || !BLOCK_REASONS_THAT_ESCALATE.has(reason)) {
        break;  // page loaded fine, just no emails — escalation won't help
      }
    } catch (err) {
      lastBlockReason = `error:${(err as Error).message.slice(0, 100)}`;
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  // Final fallback — MX-validated guess
  const guess = await mxValidatedGuess(websiteUrl);
  if (guess) return { email: guess, tier: 'mx', blockReason: lastBlockReason };

  return { email: null, tier: 'none', blockReason: lastBlockReason };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface EnrichableLead {
  id?: string;
  trustpilot_url?: string;
  website_url?: string | null;
  website_email?: string | null;
  [k: string]: unknown;
}

export interface EnrichmentResult {
  lead: EnrichableLead;
  foundEmail: string | null;
  source: 'scrape' | 'mx' | 'none';
  tier: Tier | 'mx' | 'none';
  blockReason?: string;
}

export async function enrichLeads(
  leads: EnrichableLead[],
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<EnrichmentResult[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 5));

  // Filter out leads that can't be enriched
  const queue = leads
    .map((l, idx) => ({ idx, lead: l }))
    .filter(({ lead }) => lead.website_url && !lead.website_email);

  const results: EnrichmentResult[] = leads.map((lead) => ({
    lead,
    foundEmail: null,
    source: 'none',
    tier: 'none',
  }));

  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < queue.length) {
      const i = cursor++;
      const { idx, lead } = queue[i];
      const websiteUrl = lead.website_url!;

      console.log(`  [enricher] [${done + 1}/${queue.length}] ${websiteUrl}`);
      try {
        const { email, tier, blockReason } = await enrichSingleLeadWithTiers(websiteUrl);
        results[idx] = {
          lead,
          foundEmail: email,
          source: tier === 'mx' ? 'mx' : tier === 'none' ? 'none' : 'scrape',
          tier,
          blockReason,
        };
        if (email) {
          console.log(`    [enricher] ✓ ${email} (tier=${tier})`);
        } else {
          console.log(`    [enricher] ✗ no email (blockReason=${blockReason || 'none'})`);
        }
      } catch (err) {
        console.error(`    [enricher] ERROR for ${websiteUrl}:`, (err as Error).message);
      }

      done++;
      opts.onProgress?.(done, queue.length);
      // Small jitter between tasks in the same worker
      await humanDelay(400, 1200);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

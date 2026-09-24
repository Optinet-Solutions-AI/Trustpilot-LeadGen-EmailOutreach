/**
 * Seed inbox-placement test: send one identical message to every address in a
 * seed CSV, splitting the list round-robin across every Ongage sender in
 * ONGAGE_SENDERS, so each sending domain's placement can be compared on the
 * same content.
 *
 * Sends go straight through sendEmailOngage — no campaign, no lead rows, so
 * the seeds never enter the CRM or the sent-emails dedup set.
 *
 * Resume-safe: results are written to --out after every send, and a rerun
 * skips any seed already marked sent. The same JSON is mirrored to the private
 * `seed-tests` Storage bucket (<runId>/results.json), which the unlinked
 * /seed-test/<runId> page reads. Placements live in a separate object the
 * API owns, so nothing here can overwrite what people recorded.
 *
 * Usage (from /server):
 *   npx tsx scripts/seed-placement-send.ts --csv "../September-2nd seed-100-Gmail.csv"            # dry run
 *   npx tsx scripts/seed-placement-send.ts --csv "../September-2nd seed-100-Gmail.csv" --send     # live
 *   options: --run-id <id> --out <json> --min-delay 20 --max-delay 60 (seconds between sends) --limit <n>
 */

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Imported after dotenv so config.ts sees the env.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendEmailOngage } = require('../src/services/email-sender.ongage.js') as typeof import('../src/services/email-sender.ongage.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getSupabase } = require('../src/lib/supabase.js') as typeof import('../src/lib/supabase.js');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const csvPath = arg('csv');
if (!csvPath) { console.error('--csv is required'); process.exit(1); }
const live = process.argv.includes('--send');
const runId = arg('run-id', `seed-${new Date().toISOString().slice(0, 10)}`)!;
const outPath = path.resolve(arg('out', path.resolve(__dirname, `../../.tmp/seed-test/${runId}.json`))!);
const minDelay = Number(arg('min-delay', '20')) * 1000;
const maxDelay = Number(arg('max-delay', '60')) * 1000;
const limitArg = arg('limit');
const limit = limitArg === undefined ? Infinity : Number(limitArg);  // canary: send only the next N

const SUBJECT = 'Quick question about your online reviews';
const BODY = (ref: string, fromName: string) =>
  '<p>Hi there,</p>\n' +
  '<p>I came across your business while looking at local companies with recent customer reviews, ' +
  'and noticed a few that went unanswered. Replying to them — even the unhappy ones — is one of the ' +
  'simplest ways to win back trust with people deciding whether to call you.</p>\n' +
  '<p>We help small businesses respond to and recover their reviews. Would a short summary of what ' +
  'we found be useful?</p>\n' +
  `<p>Best,<br>${fromName.replace(/ at .*/, '')}<br>OptiRate</p>\n` +
  `<p style="font-size:10px;color:#bbb;">Ref ${ref}</p>`;

interface Sender { connectionId: number; email: string; fromName: string }
interface SeedResult {
  n: number; email: string; sender: string; ref: string;
  status: 'queued' | 'sent' | 'failed'; sent_at: string | null; error: string | null;
}

function senders(): Sender[] {
  return (process.env.ONGAGE_SENDERS || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [conn, email, ...name] = s.split(':');
    return { connectionId: parseInt(conn, 10), email: email.trim().toLowerCase(), fromName: name.join(':').trim() || 'OptiRate' };
  }).filter((s) => s.connectionId && s.email);
}

function readSeeds(file: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const e = line.split(',')[0].trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

function save(results: SeedResult[]) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ runId, subject: SUBJECT, updated_at: new Date().toISOString(), results }, null, 2));
}

async function syncDb(results: SeedResult[]) {
  if (!live) return;
  const body = JSON.stringify({ runId, subject: SUBJECT, updated_at: new Date().toISOString(), results });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await getSupabase().storage.from('seed-tests').upload(
      `${runId}/results.json`, new Blob([body], { type: 'application/json' }),
      { upsert: true, contentType: 'application/json', cacheControl: '0' },
    );
    if (!error) return;
    console.warn(`[seed] sync failed (attempt ${attempt}): ${error.message}`);
    await new Promise((ok) => setTimeout(ok, 1000 * attempt));
  }
}

async function main() {
  const pool = senders();
  if (pool.length === 0) throw new Error('ONGAGE_SENDERS is empty');
  const seeds = readSeeds(path.resolve(csvPath!));

  const prior = fs.existsSync(outPath) ? (JSON.parse(fs.readFileSync(outPath, 'utf8')).results as SeedResult[]) : [];
  const byEmail = new Map(prior.map((r) => [r.email, r]));
  const results: SeedResult[] = seeds.map((email, i) => byEmail.get(email) ?? {
    n: i + 1, email, sender: pool[i % pool.length].email, ref: `${runId}-${String(i + 1).padStart(3, '0')}`,
    status: 'queued', sent_at: null, error: null,
  });
  save(results);

  const counts = pool.map((s) => `${s.email}=${results.filter((r) => r.sender === s.email).length}`).join(' ');
  console.log(`[seed] ${seeds.length} seeds, ${pool.length} senders (${counts}) → ${outPath}`);
  if (!live) { console.log('[seed] dry run — pass --send to dispatch'); return; }
  await syncDb(results);

  const todo = results.filter((r) => r.status !== 'sent').slice(0, limit);
  for (let k = 0; k < todo.length; k++) {
    const r = todo[k];
    const s = pool.find((p) => p.email === r.sender)!;
    const res = await sendEmailOngage(r.email, SUBJECT, BODY(r.ref, s.fromName), {}, {
      email: s.email, fromName: s.fromName, auth_type: 'ongage', ongage_connection_id: s.connectionId,
    });
    r.status = res.success ? 'sent' : 'failed';
    r.sent_at = new Date().toISOString();
    r.error = res.success ? null : (res.error ?? 'unknown error');
    save(results);
    await syncDb(results);
    console.log(`[seed] ${new Date().toISOString()} ${r.n}/${results.length} ${r.email} via ${r.sender}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
    if (k < todo.length - 1) await new Promise((ok) => setTimeout(ok, minDelay + Math.random() * (maxDelay - minDelay)));
  }
  const sent = results.filter((r) => r.status === 'sent').length;
  console.log(`[seed] done: ${sent} sent, ${results.length - sent} not sent`);
}

main().catch((e) => { console.error(e); process.exit(1); });

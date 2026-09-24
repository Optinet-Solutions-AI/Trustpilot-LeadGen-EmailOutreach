/**
 * Seed inbox-placement test: send one identical message to every address in a
 * seed CSV from EVERY Ongage sender in ONGAGE_SENDERS, so each sending
 * domain's placement is measured on the same mailboxes and the same content.
 *
 * Sends go straight through sendEmailOngage — no campaign, no lead rows, so
 * the seeds never enter the CRM or the sent-emails dedup set. That also means
 * the campaign scheduler's cap counting never sees them: --per-day is the only
 * limit on them.
 *
 * Unsent (seed, sender) pairs are planned onto Manila days at --per-day per
 * sender. Run with --send once a day to dispatch that day's batch; a missed day
 * rolls the rest of the plan forward, so the dates shown are always honest.
 *
 * Resume-safe: results are written to --out after every send, and a rerun
 * skips any pair already sent. The same JSON is mirrored to the private
 * `seed-tests` Storage bucket (<runId>/results.json), which the unlinked
 * /seed-test/<runId> page reads. Placements live in a separate object the
 * API owns, so nothing here can overwrite what people recorded.
 *
 * Usage (from /server):
 *   npx tsx scripts/seed-placement-send.ts --csv "../September-2nd seed-100-Gmail.csv"            # print the plan
 *   npx tsx scripts/seed-placement-send.ts --csv "../September-2nd seed-100-Gmail.csv" --sync     # publish the plan
 *   npx tsx scripts/seed-placement-send.ts --csv "../September-2nd seed-100-Gmail.csv" --send     # send today's batch
 *   options: --run-id <id> --per-day 20 --out <json> --limit <n>
 *            --min-delay 90 --max-delay 150 (seconds between sends)
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
// Default pacing keeps each sender well under its 15/hour ceiling: with three
// senders interleaved, one send every ~2 minutes is ~10/hour per sender.
const minDelay = Number(arg('min-delay', '90')) * 1000;
const maxDelay = Number(arg('max-delay', '150')) * 1000;
const limitArg = arg('limit');
const limit = limitArg === undefined ? Infinity : Number(limitArg);  // canary: send only the next N
// Matches the live dailyCap on the Ongage accounts (20 on 2026-09-24).
const perDay = Number(arg('per-day', '20'));
const TZ = 'Asia/Manila';

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
  /** Manila calendar day this pair went out, or is planned to (YYYY-MM-DD). */
  scheduled_for?: string | null;
}

/** YYYY-MM-DD in Manila for an instant. */
function manilaDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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

function payload(results: SeedResult[]) {
  return JSON.stringify({ runId, subject: SUBJECT, per_day: perDay, timezone: TZ, updated_at: new Date().toISOString(), results }, null, 2);
}

function save(results: SeedResult[]) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, payload(results));
}

async function syncDb(results: SeedResult[]) {
  const body = payload(results);
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

/** One row per (seed, sender). The first run gave each seed one sender and
 *  the bare ref; those rows keep it, the other pairs get a sender suffix. */
function buildPairs(seeds: string[], pool: Sender[], prior: SeedResult[]): SeedResult[] {
  const byPair = new Map(prior.map((r) => [`${r.email}|${r.sender}`, r]));
  const out: SeedResult[] = [];
  seeds.forEach((email, i) => {
    const nnn = String(i + 1).padStart(3, '0');
    for (const s of pool) {
      out.push(byPair.get(`${email}|${s.email}`) ?? {
        n: i + 1, email, sender: s.email, ref: `${runId}-${nnn}-${s.email.split('@')[0]}`,
        status: 'queued', sent_at: null, error: null,
      });
    }
  });
  return out;
}

/** Plan unsent pairs onto days, perDay per sender. Today only gets what is
 *  left after today's seed sends. */
function plan(results: SeedResult[], pool: Sender[]) {
  const today = manilaDay(new Date());
  for (const s of pool) {
    const mine = results.filter((r) => r.sender === s.email);
    for (const r of mine) if (r.status === 'sent' && r.sent_at) r.scheduled_for = manilaDay(new Date(r.sent_at));
    const usedToday = mine.filter((r) => r.status === 'sent' && r.scheduled_for === today).length;
    let day = today;
    let room = Math.max(0, perDay - usedToday);
    for (const r of mine.filter((x) => x.status !== 'sent').sort((a, b) => a.n - b.n)) {
      while (room === 0) { day = addDays(day, 1); room = perDay; }
      r.scheduled_for = day;
      room--;
    }
  }
}

async function main() {
  const pool = senders();
  if (pool.length === 0) throw new Error('ONGAGE_SENDERS is empty');
  const seeds = readSeeds(path.resolve(csvPath!));

  const prior = fs.existsSync(outPath) ? (JSON.parse(fs.readFileSync(outPath, 'utf8')).results as SeedResult[]) : [];
  const results = buildPairs(seeds, pool, prior);
  plan(results, pool);
  save(results);

  const today = manilaDay(new Date());
  console.log(`[seed] ${seeds.length} seeds × ${pool.length} senders = ${results.length} pairs, ${perDay}/sender/day (${TZ}) → ${outPath}`);
  for (const d of [...new Set(results.map((r) => r.scheduled_for!))].sort()) {
    const row = pool.map((s) => {
      const x = results.filter((r) => r.sender === s.email && r.scheduled_for === d);
      return `${s.email.split('@')[0]} ${x.filter((r) => r.status === 'sent').length}/${x.length}`;
    }).join('  ');
    console.log(`[seed]   ${d}${d === today ? ' (today)' : ''}  sent/planned: ${row}`);
  }
  if (!live) {
    if (process.argv.includes('--sync')) { await syncDb(results); console.log('[seed] plan published'); }
    else console.log('[seed] dry run — pass --sync to publish the plan, --send to dispatch today\'s batch');
    return;
  }
  await syncDb(results);

  // Today's batch only, interleaved across senders so no domain bursts.
  const queues = pool.map((s) => results
    .filter((r) => r.sender === s.email && r.status !== 'sent' && r.scheduled_for === today)
    .sort((a, b) => a.n - b.n));
  const todo: SeedResult[] = [];
  for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (q[i]) todo.push(q[i]);
  const batch = todo.slice(0, limit);
  console.log(`[seed] sending ${batch.length} due today (${today})`);

  for (let k = 0; k < batch.length; k++) {
    const r = batch[k];
    const s = pool.find((p) => p.email === r.sender)!;
    const res = await sendEmailOngage(r.email, SUBJECT, BODY(r.ref, s.fromName), {}, {
      email: s.email, fromName: s.fromName, auth_type: 'ongage', ongage_connection_id: s.connectionId,
    });
    r.status = res.success ? 'sent' : 'failed';
    r.sent_at = new Date().toISOString();
    r.error = res.success ? null : (res.error ?? 'unknown error');
    save(results);
    await syncDb(results);
    console.log(`[seed] ${new Date().toISOString()} ${k + 1}/${batch.length} ${r.email} via ${r.sender}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
    if (k < batch.length - 1) await new Promise((ok) => setTimeout(ok, minDelay + Math.random() * (maxDelay - minDelay)));
  }
  const sent = results.filter((r) => r.status === 'sent').length;
  console.log(`[seed] done for today: ${sent}/${results.length} pairs sent overall`);
}

main().catch((e) => { console.error(e); process.exit(1); });

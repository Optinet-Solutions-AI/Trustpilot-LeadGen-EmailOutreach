/**
 * Seed inbox-placement test — set up or update a run's plan.
 *
 * This script never sends. Sending is done by the API on Cloud Run
 * (src/services/seed-test/sender.ts), so the plan keeps going with this
 * machine off and there is only ever one sender. Running both is what put
 * duplicate copies in 12 seed mailboxes on 2026-09-24.
 *
 * What it does: reads the run from the private `seed-tests` bucket (falling
 * back to the local .tmp copy), makes one row per (seed, sender) — every seed
 * is mailed once by EVERY sender — plans unsent pairs onto Manila days at
 * --per-day per sender, and writes it back. --auto on|off turns the
 * background sender on or off for the run.
 *
 * Usage (from /server):
 *   npx tsx scripts/seed-placement-send.ts --csv "../September-2nd seed-100-Gmail.csv" --run-id <id>              # print the plan
 *   npx tsx scripts/seed-placement-send.ts --csv "../September-2nd seed-100-Gmail.csv" --run-id <id> --auto on    # publish + start sending
 *   npx tsx scripts/seed-placement-send.ts --csv ... --run-id <id> --auto off                                    # stop sending
 *   options: --per-day 20
 */

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Imported after dotenv so config.ts sees the env.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getSupabase } = require('../src/lib/supabase.js') as typeof import('../src/lib/supabase.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../src/services/seed-test/plan.js') as typeof import('../src/services/seed-test/plan.js');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const csvPath = arg('csv');
const runId = arg('run-id');
if (!csvPath || !runId) { console.error('--csv and --run-id are required'); process.exit(1); }
const auto = arg('auto');                       // 'on' | 'off' | undefined (print only)
const perDay = Number(arg('per-day', '20'));    // matches the live dailyCap (20 on 2026-09-24)
const localPath = path.resolve(__dirname, `../../.tmp/seed-test/${runId}.json`);
const BUCKET = 'seed-tests';

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

async function readRemote(): Promise<import('../src/services/seed-test/plan.js').SeedRun | null> {
  const { data, error } = await getSupabase().storage.from(BUCKET).download(`${runId}/results.json`);
  if (error || !data) return null;
  return JSON.parse(await data.text());
}

async function main() {
  const pool = P.parseSeedSenders(process.env.ONGAGE_SENDERS);
  if (pool.length === 0) throw new Error('ONGAGE_SENDERS is empty');
  const seeds = readSeeds(path.resolve(csvPath!));

  const remote = await readRemote();
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : null;
  const base = remote ?? local;
  const results = P.buildPairs(runId!, seeds, pool, base?.results ?? []);
  P.planPairs(results, pool.map((s) => s.email), perDay);

  const run = {
    ...(base ?? {}),
    runId: runId!, subject: base?.subject ?? P.SEED_SUBJECT, per_day: perDay, timezone: P.SEED_TZ,
    auto_send: auto === 'on' ? true : auto === 'off' ? false : (base?.auto_send ?? false),
    updated_at: new Date().toISOString(), results,
  };

  const today = P.manilaDay(new Date());
  console.log(`[seed] ${seeds.length} seeds × ${pool.length} senders = ${results.length} pairs, ${perDay}/sender/day (${P.SEED_TZ}), auto_send=${run.auto_send}`);
  for (const d of [...new Set(results.map((r) => r.scheduled_for!))].sort()) {
    const row = pool.map((s) => {
      const x = results.filter((r) => r.sender === s.email && r.scheduled_for === d);
      return `${s.email.split('@')[0]} ${x.filter((r) => r.status === 'sent').length}/${x.length}`;
    }).join('  ');
    console.log(`[seed]   ${d}${d === today ? ' (today)' : ''}  sent/planned: ${row}`);
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, JSON.stringify(run, null, 2));
  if (auto === undefined) { console.log('[seed] printed only — pass --auto on|off to publish'); return; }

  const { error } = await getSupabase().storage.from(BUCKET).upload(
    `${runId}/results.json`, new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }),
    { upsert: true, contentType: 'application/json', cacheControl: '0' },
  );
  if (error) throw error;
  console.log(`[seed] published — background sender ${run.auto_send ? 'ON' : 'OFF'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

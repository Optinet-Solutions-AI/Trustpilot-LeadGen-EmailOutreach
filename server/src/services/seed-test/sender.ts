/**
 * Background sender for seed inbox-placement tests.
 *
 * Runs inside the API on Cloud Run so the plan keeps going with the
 * operator's machine off. Each minute, at most ONE seed email goes out, and
 * only when:
 *   - the run's results.json in the private `seed-tests` bucket has
 *     `auto_send: true`
 *   - it is inside the Manila send window
 *   - the gap since the run's last send has passed (next_send_after)
 *   - that sender has room left under per_day today (counted from sent_at)
 *   - this instance holds the `seed-test-sender` leader lock
 *
 * Unlike the campaign loops, this FAILS CLOSED when the lock is unavailable:
 * seeds are a test, and a duplicate to a seed skews the result it exists for.
 *
 * Each pair is claimed in storage (claimed_at) before the email is sent. A
 * pair found claimed but not recorded — an instance died mid-send — is marked
 * failed rather than retried, so an unknown outcome is never sent twice.
 *
 * These sends bypass the campaign scheduler, so its per-mailbox caps never
 * see them; per_day is the only limit. Honours EMAIL_SENDING_PAUSED_UNTIL.
 */
import { getSupabase } from '../../lib/supabase.js';
import { acquireSchedulerLock, releaseSchedulerLock, INSTANCE_ID } from '../scheduler-lock.js';
import { exclusive } from '../tick-guard.js';
import { sendEmailOngage } from '../email-sender.ongage.js';
import {
  manilaHour, nextDuePair, parseSeedSenders, planPairs, seedBody,
  type SeedResult, type SeedRun,
} from './plan.js';

const BUCKET = 'seed-tests';
const LOCK = 'seed-test-sender';
const POLL_MS = 60_000;
/** Manila hours, inclusive start / exclusive end. */
const WINDOW = { start: 9, end: 21 };
/** Gap between two seed sends of one run, randomised in this range. With
 *  three senders rotating, ~2-3 min is ~8/hour per sender — under the 15/hour
 *  mailbox ceiling. */
const GAP_MS = { min: 120_000, max: 180_000 };
/** A claim older than this with no recorded outcome is treated as interrupted. */
const STALE_CLAIM_MS = 10 * 60_000;

type Row = SeedResult & { claimed_at?: string | null };
type Run = SeedRun & { results: Row[]; next_send_after?: string | null };

async function readRun(runId: string): Promise<Run | null> {
  const { data, error } = await getSupabase().storage.from(BUCKET).download(`${runId}/results.json`);
  if (error || !data) return null;
  return JSON.parse(await data.text()) as Run;
}

async function writeRun(run: Run): Promise<boolean> {
  run.updated_at = new Date().toISOString();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await getSupabase().storage.from(BUCKET).upload(
      `${run.runId}/results.json`,
      new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }),
      { upsert: true, contentType: 'application/json', cacheControl: '0' },
    );
    if (!error) return true;
    console.warn(`[SeedTestSender] write ${run.runId} failed (attempt ${attempt}): ${error.message}`);
    await new Promise((ok) => setTimeout(ok, 1000 * attempt));
  }
  return false;
}

async function listRunIds(): Promise<string[]> {
  const { data, error } = await getSupabase().storage.from(BUCKET).list('', { limit: 100 });
  if (error || !data) return [];
  // Folders come back with no id/metadata.
  return data.filter((o) => !o.id).map((o) => o.name);
}

function paused(): boolean {
  const until = process.env.EMAIL_SENDING_PAUSED_UNTIL;
  if (!until) return false;
  const t = new Date(until).getTime();
  return !Number.isNaN(t) && t > Date.now();
}

async function processRun(runId: string): Promise<void> {
  const run = await readRun(runId);
  if (!run?.auto_send) return;

  const pool = parseSeedSenders(process.env.ONGAGE_SENDERS);
  const now = new Date();
  let dirty = false;

  // Settle claims an instance never finished: outcome unknown, so never resend.
  for (const r of run.results) {
    if (r.status === 'queued' && r.claimed_at && now.getTime() - new Date(r.claimed_at).getTime() > STALE_CLAIM_MS) {
      r.status = 'failed';
      r.sent_at = r.claimed_at;
      r.error = 'Interrupted mid-send — outcome unknown, not retried to avoid a duplicate';
      r.claimed_at = null;
      dirty = true;
    }
  }

  // Keep the dates on the page honest if a day was missed.
  const before = JSON.stringify(run.results.map((r) => r.scheduled_for));
  planPairs(run.results, pool.map((s) => s.email), run.per_day, now);
  if (JSON.stringify(run.results.map((r) => r.scheduled_for)) !== before) dirty = true;

  const hour = manilaHour(now);
  const inWindow = hour >= WINDOW.start && hour < WINDOW.end;
  const gapOk = !run.next_send_after || new Date(run.next_send_after).getTime() <= now.getTime();
  const pair = inWindow && gapOk
    ? (nextDuePair(run.results, pool.map((s) => s.email), run.per_day, now) as Row | null)
    : null;

  if (!pair || pair.claimed_at) {
    if (dirty) await writeRun(run);
    return;
  }
  const sender = pool.find((s) => s.email === pair.sender);
  if (!sender) {
    if (dirty) await writeRun(run);
    return;
  }

  // Claim first. If the claim cannot be recorded, do not send.
  pair.claimed_at = now.toISOString();
  if (!(await writeRun(run))) return;

  const res = await sendEmailOngage(pair.email, run.subject, seedBody(pair.ref, sender.fromName), {}, {
    email: sender.email, fromName: sender.fromName, auth_type: 'ongage', ongage_connection_id: sender.connectionId,
  });
  pair.status = res.success ? 'sent' : 'failed';
  pair.sent_at = new Date().toISOString();
  pair.error = res.success ? null : (res.error ?? 'unknown error');
  pair.claimed_at = null;
  run.next_send_after = new Date(Date.now() + GAP_MS.min + Math.random() * (GAP_MS.max - GAP_MS.min)).toISOString();
  await writeRun(run);
  console.log(`[SeedTestSender] ${run.runId} ${pair.ref} ${pair.email} via ${pair.sender}: ${pair.status}${pair.error ? ` (${pair.error})` : ''}`);
}

async function tick(): Promise<void> {
  if (paused()) return;
  const supabase = getSupabase();
  const outcome = await acquireSchedulerLock(supabase, LOCK, INSTANCE_ID, 5 * 60_000);
  if (outcome !== 'acquired') return; // fail closed — see header
  try {
    for (const runId of await listRunIds()) {
      try {
        await processRun(runId);
      } catch (e) {
        console.error(`[SeedTestSender] ${runId}:`, e instanceof Error ? e.message : e);
      }
    }
  } finally {
    await releaseSchedulerLock(supabase, LOCK, INSTANCE_ID);
  }
}

export function startSeedTestSender(): void {
  const guarded = exclusive(tick, 'SeedTestSender');
  setInterval(() => { void guarded(); }, POLL_MS);
  console.log('[SeedTestSender] started — polling every 60s');
}

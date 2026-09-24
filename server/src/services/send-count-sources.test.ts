import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * A standing guard, not a unit test.
 *
 * `campaign_leads.sent_at` and `campaign_leads.sender_email` hold ONE value
 * per lead-campaign pair and are overwritten by every later step in the
 * sequence. Anything that counts emails from them under-reports the moment a
 * sequence moves on. This has been found and fixed three times in the same
 * codebase, each time in a different place and each time after it had misled
 * someone in production:
 *
 *   2026-09-16  Daily Activity chart — 483 sends shown as 310, five days that
 *               really sent 21-30 each reading zero. Read as "sending has
 *               stalled".
 *   2026-09-24  Send queue calendar — 675 September sends shown as 376, the
 *               16th blank on a day that sent 44.
 *   2026-09-24  The daily send CAP itself, and the day-load the scheduler
 *               books against. Accurate only by the accident that a 3-day
 *               follow-up delay keeps two sends for one lead outside the 24h
 *               window.
 *
 * The durable source is `lead_notes` — append-only, one row per email sent,
 * never rewritten. Counts take the higher of the two (`mergeCounts` /
 * `reconcileSentCount`) so an incomplete source can only ever make a count
 * stricter, never looser.
 *
 * This test exists so the fourth instance fails here instead of in front of
 * the operator.
 */

const SRC = join(import.meta.dirname, '..');

/**
 * Files allowed to read `sent_at` / `sender_email` from campaign_leads, each
 * with the reason it is safe. Adding a file here is a deliberate act: say why
 * it cannot under-count, or route it through sent-log.ts instead.
 */
const ALLOWED = new Map<string, string>([
  // Counting, but merged with the append-only log.
  ['services/send-counts.ts', 'merges with lead_notes via reconcileSentCount'],
  ['services/day-load.ts', 'merges with lead_notes via mergeCounts'],
  ['routes/campaigns.ts', 'calendar and re-pacer both merge via sent-log.ts'],
  ['services/sent-log.ts', 'this IS the append-only reader'],
  ['services/daily-activity.ts', 'counts lead_notes events, not rows'],

  // Writers. Stamping the column is what the column is for.
  ['services/campaign-scheduler.ts', 'writes sent_at when an email leaves'],
  ['services/campaign-sender.ts', 'writes sent_at when an email leaves'],
  ['services/sequence-scheduler.ts', 'writes sent_at when a follow-up leaves'],
  ['services/email-sender.mock.ts', 'writes sent_at in mock mode'],
  ['services/platform-sync.ts', 'writes sent_at from platform status'],
  ['routes/webhooks.ts', 'writes sent_at from a delivery webhook'],

  // Reads that are about ONE row, not a count across rows.
  ['routes/inbox.ts', 'per-thread display and ordering, never a total'],
  ['db/campaigns.ts', 'dedupe set of addresses; a later sent_at only ever adds'],
  ['services/queue-forecast.ts', 'places future steps; reads no sent totals'],
  ['services/follow-up-claim.ts', 'WRITES the sending mailbox onto the log entry'],
  ['services/reply-tracker.imap.ts',
   'picks which rows a mailbox should watch for replies, not a count; follow-ups '
   + 'reuse the recorded sender, so the row keeps naming the right mailbox'],
  ['routes/analytics.ts', 'counts lead_notes; sent_at appears only in comments'],

  ['routes/email-accounts.ts', 'displays the shared loadSentCounts figure, computes none itself'],
  ['services/follow-up-budget.ts', 'names the column in a doc comment only'],

  // Unrelated tables that happen to use the same column name.
  ['routes/warmup.ts', 'warmup_pipeline table, not campaign_leads'],
  ['services/warmup-scheduler.ts', 'warmup tables; loops removed from startup'],
  ['services/colleague-warmup/plan.ts', 'colleague warm-up plan, own table'],
  ['services/colleague-warmup/scheduler.ts', 'colleague warm-up, own table'],
  ['services/colleague-warmup/notifier.ts', 'colleague warm-up report template'],

  // Operator tools, run by hand and read-only.
  ['tools/queue-dryrun.ts', 'read-only ops tool'],
  ['tools/queue-what-if.ts', 'read-only ops tool'],
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith('.ts') && !name.includes('.test.')) out.push(full);
  }
  return out;
}

describe('where send counts may come from', () => {
  test('no new file reads sent_at or sender_email without saying why it is safe', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => /\bsent_at\b|\bsender_email\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel));

    expect(offenders, [
      'These files read campaign_leads.sent_at / sender_email, which are',
      'OVERWRITTEN by every later step in a sequence. If you are counting',
      'emails, count lead_notes instead (services/sent-log.ts) and merge with',
      'mergeCounts so the stricter number wins. If the read is safe, add the',
      'file to ALLOWED above with the reason.',
    ].join(' ')).toEqual([]);
  });

  test('every allowlist entry still exists, so the list cannot rot', () => {
    const present = new Set(sourceFiles(SRC).map((f) => relative(SRC, f).split(sep).join('/')));
    expect([...ALLOWED.keys()].filter((f) => !present.has(f))).toEqual([]);
  });
});

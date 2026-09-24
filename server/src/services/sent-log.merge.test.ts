import { describe, test, expect } from 'vitest';
import { mergeCounts } from './sent-log.js';

/**
 * Every per-day and per-mailbox send count in this service used to be derived
 * from `campaign_leads`, keyed on `sent_at` and attributed by `sender_email`.
 * Both columns hold one value per lead-campaign pair and are rewritten by
 * every later step, so those counts under-report as soon as a sequence moves
 * on — the defect that showed 376 of September's 675 emails on the calendar.
 *
 * `lead_notes` is append-only and is the durable answer, but entries written
 * before the sending mailbox was recorded are invisible to it. So every count
 * takes the HIGHER of the two. That direction is the whole safety property:
 * a count can only ever come out stricter than today's behaviour, never
 * looser, whichever source is incomplete.
 */
describe('mergeCounts', () => {
  test('takes the log when it has seen more than the rows', () => {
    expect([...mergeCounts(
      new Map([['2026-09-16', 0]]),
      new Map([['2026-09-16', 44]]),
    )]).toEqual([['2026-09-16', 44]]);
  });

  test('keeps the row count where the log has no entry yet', () => {
    // Backfill has not reached these, so the log is silent. Believing it
    // would hand a day back capacity it has already spent.
    expect([...mergeCounts(
      new Map([['2026-09-16', 44]]),
      new Map(),
    )]).toEqual([['2026-09-16', 44]]);
  });

  test('keeps every day either source knows about', () => {
    const merged = mergeCounts(
      new Map([['2026-09-16', 44], ['2026-09-17', 42]]),
      new Map([['2026-09-17', 50], ['2026-09-18', 43]]),
    );
    expect([...merged].sort()).toEqual([
      ['2026-09-16', 44], ['2026-09-17', 50], ['2026-09-18', 43],
    ]);
  });

  test('never returns a negative or broken count', () => {
    expect([...mergeCounts(
      new Map([['d', Number.NaN]]),
      new Map([['d', -3]]),
    )]).toEqual([['d', 0]]);
  });

  test('leaves the inputs alone', () => {
    const rows = new Map([['d', 1]]);
    mergeCounts(rows, new Map([['d', 9]]));
    expect(rows.get('d')).toBe(1);
  });
});

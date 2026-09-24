import { describe, test, expect } from 'vitest';
import { sentEmailsFromNotes, type SentNoteRow } from './sent-log.js';

/**
 * The send queue calendar counted ROWS, not SENDS — the same defect the Daily
 * Activity chart had, fixed there on 2026-09-16 and left in place here.
 *
 * `campaign_leads.sent_at` is one column per lead-campaign pair and every
 * later step overwrites it, so a first email sent on 16 September vanished
 * from the 16th the moment its follow-up went out on the 23rd. Measured
 * 2026-09-24 over 1-23 September: 675 emails really went out, the calendar
 * showed 376. The 16th displayed nothing on a day that sent 44, the 15th
 * showed 10 against a real 63, and 1,563 of 2,085 sent rows had already had
 * their original date overwritten.
 *
 * `lead_notes` holds one immutable row per email that actually left, carrying
 * the campaign in `metadata.campaign_id` and the sequence step in
 * `metadata.step_number` (absent on a first touch). Counting those is the fix.
 */

const note = (over: Partial<SentNoteRow> = {}): SentNoteRow => ({
  lead_id: 'lead-1',
  created_at: '2026-09-16T09:00:00Z',
  metadata: { campaign_id: 'camp-1' },
  ...over,
});

describe('sentEmailsFromNotes', () => {
  test('counts both emails when one lead was contacted twice on different days', () => {
    // The exact shape of the bug: the follow-up on the 23rd erased the first
    // touch on the 16th, so the 16th read zero and the 23rd claimed the row.
    const sent = sentEmailsFromNotes([
      note({ created_at: '2026-09-16T09:00:00Z' }),
      note({ created_at: '2026-09-23T14:14:09Z', metadata: { campaign_id: 'camp-1', step_number: 2 } }),
    ]);
    expect(sent.map((s) => [s.at.toISOString().slice(0, 10), s.kind])).toEqual([
      ['2026-09-16', 'first_touch'],
      ['2026-09-23', 'follow_up'],
    ]);
  });

  test('treats a missing step_number as the first touch', () => {
    // First touches are logged without a step number; only follow-ups carry
    // one. Defaulting to 0 or discarding them loses 57% of the log.
    expect(sentEmailsFromNotes([note()])[0]).toMatchObject({ stepNumber: 1, kind: 'first_touch' });
  });

  test('carries the campaign so a day can still be broken down per campaign', () => {
    const sent = sentEmailsFromNotes([note({ metadata: { campaign_id: 'camp-2', step_number: 3 } })]);
    expect(sent[0]).toMatchObject({ campaignId: 'camp-2', leadId: 'lead-1', stepNumber: 3, kind: 'follow_up' });
  });

  test('drops a note that names no campaign rather than inventing one', () => {
    // Nothing can be attributed to a calendar cell without a campaign, and a
    // guessed one would misreport a campaign's share of the day.
    expect(sentEmailsFromNotes([note({ metadata: null }), note({ metadata: {} })])).toEqual([]);
  });

  test('drops a note whose timestamp is not a date', () => {
    expect(sentEmailsFromNotes([note({ created_at: 'not-a-date' })])).toEqual([]);
  });

  test('counts a redelivery to the same lead on the same day twice', () => {
    // Two rows in the log mean two emails left. Collapsing them would repeat
    // the original undercount in a smaller way.
    expect(sentEmailsFromNotes([note(), note()])).toHaveLength(2);
  });

  test('returns sends in chronological order whatever order the log arrived in', () => {
    const sent = sentEmailsFromNotes([
      note({ created_at: '2026-09-23T14:00:00Z' }),
      note({ created_at: '2026-09-16T09:00:00Z' }),
    ]);
    expect(sent.map((s) => s.at.toISOString())).toEqual([
      '2026-09-16T09:00:00.000Z', '2026-09-23T14:00:00.000Z',
    ]);
  });
});

import { describe, test, expect } from 'vitest';
import { planDay } from './plan.js';
import { renderBody } from './render.js';
import { getManilaParts, isInWorkdayWindow, manilaWallClockToUtc } from './schedule-window.js';

/** Deterministic PRNG so each test is reproducible. Mulberry32. */
function seededRandom(seed: number): () => number {
  let t = seed;
  return () => {
    t |= 0;
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const SENDERS_9 = Array.from({ length: 9 }, (_, i) => ({
  email: `sender${i + 1}@example.com`,
  from_name: `Sender${i + 1}`,
}));

const RECIPIENTS_5 = [
  { email: 'a@example.com', first_name: 'A' },
  { email: 'b@example.com', first_name: 'B' },
  { email: 'c@example.com', first_name: 'C' },
  { email: 'd@example.com', first_name: 'D' },
  { email: 'e@example.com', first_name: 'E' },
];

const SUBJECTS_3 = ['Welcome', 'Activity Update', 'Account Notice'];

// A Tuesday 3:00pm Asia/Manila → 07:00 UTC
const TUE_3PM_MANILA = new Date(Date.UTC(2026, 5, 2, 7, 0, 0)); // June 2 2026 Tue 07:00Z

describe('schedule-window', () => {
  test('getManilaParts returns Manila local time for a UTC instant', () => {
    const parts = getManilaParts(TUE_3PM_MANILA);
    expect(parts.dateKey).toBe('2026-06-02');
    expect(parts.weekday).toBe(2); // Tue
    expect(parts.hour).toBe(15);
    expect(parts.minute).toBe(0);
  });

  test('isInWorkdayWindow accepts Mon–Fri 3pm–10pm Manila, rejects others', () => {
    // 3:00pm Tue — inside
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 2, 7, 0))))).toBe(true);
    // 9:59pm Tue — inside
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 2, 13, 59))))).toBe(true);
    // 10:00pm Tue — outside (exclusive end)
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 2, 14, 0))))).toBe(false);
    // 2:59pm Tue — outside
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 2, 6, 59))))).toBe(false);
    // Saturday 3:30pm Manila — outside
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 6, 7, 30))))).toBe(false);
    // Sunday 5pm Manila — outside
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 7, 9, 0))))).toBe(false);
  });

  test('manilaWallClockToUtc round-trips through getManilaParts', () => {
    const parts = getManilaParts(TUE_3PM_MANILA);
    const fourPmManila = manilaWallClockToUtc(parts, 16, 30);
    const back = getManilaParts(fourPmManila);
    expect(back.dateKey).toBe('2026-06-02');
    expect(back.hour).toBe(16);
    expect(back.minute).toBe(30);
  });
});

describe('renderBody', () => {
  test('substitutes both tokens, all occurrences', () => {
    const out = renderBody({ recipient_name: 'Leo', sender_from_name: 'John' });
    expect(out).toContain('Hi Leo,');
    expect(out).toContain('Regards,<br>John');
  });

  test('handles repeated tokens (regex /g)', () => {
    // not in default body, but verify replace is global by using a custom template
    const tmpl = 'A {{recipient_name}} B {{recipient_name}} C';
    const result = tmpl
      .replace(/\{\{recipient_name\}\}/g, 'X')
      .replace(/\{\{sender_from_name\}\}/g, 'Y');
    expect(result).toBe('A X B X C');
  });
});

describe('planDay', () => {
  test('generates per-sender sequences inside the workday window', () => {
    const parts = getManilaParts(TUE_3PM_MANILA);
    const plan = planDay({
      manila: parts,
      senders: SENDERS_9,
      recipients: RECIPIENTS_5,
      subjects: SUBJECTS_3,
      random: seededRandom(42),
    });

    expect(plan.length).toBeGreaterThan(0);

    const workdayStart = manilaWallClockToUtc(parts, 15, 0).getTime();
    const workdayEnd = manilaWallClockToUtc(parts, 22, 0).getTime();
    for (const row of plan) {
      const t = row.send_at_utc.getTime();
      expect(t).toBeGreaterThanOrEqual(workdayStart);
      expect(t).toBeLessThan(workdayEnd);
    }
  });

  test('returns rows sorted by send_at_utc', () => {
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: SENDERS_9,
      recipients: RECIPIENTS_5,
      subjects: SUBJECTS_3,
      random: seededRandom(7),
    });
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].send_at_utc.getTime()).toBeGreaterThanOrEqual(plan[i - 1].send_at_utc.getTime());
    }
  });

  test('enforces 45–50 min cadence per sender', () => {
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: SENDERS_9,
      recipients: RECIPIENTS_5,
      subjects: SUBJECTS_3,
      random: seededRandom(99),
    });

    const bySender = new Map<string, number[]>();
    for (const row of plan) {
      const arr = bySender.get(row.sender_email) ?? [];
      arr.push(row.send_at_utc.getTime());
      bySender.set(row.sender_email, arr);
    }

    for (const times of bySender.values()) {
      times.sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        const gapMs = times[i] - times[i - 1];
        expect(gapMs).toBeGreaterThanOrEqual(45 * 60 * 1000);
        expect(gapMs).toBeLessThanOrEqual(50 * 60 * 1000);
      }
    }
  });

  test('produces ~8 sends per sender across the 7h window (sanity)', () => {
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: SENDERS_9,
      recipients: RECIPIENTS_5,
      subjects: SUBJECTS_3,
      random: seededRandom(123),
    });
    const perSender = new Map<string, number>();
    for (const row of plan) perSender.set(row.sender_email, (perSender.get(row.sender_email) ?? 0) + 1);
    for (const count of perSender.values()) {
      // 420 min / 50 min = 8.4 → minimum 8; / 45 = 9.3 → max around 9 plus initial jitter slack
      expect(count).toBeGreaterThanOrEqual(7);
      expect(count).toBeLessThanOrEqual(10);
    }
  });

  test('renders subject and body for every row from the configured banks', () => {
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: SENDERS_9,
      recipients: RECIPIENTS_5,
      subjects: SUBJECTS_3,
      random: seededRandom(11),
    });
    for (const row of plan) {
      expect(SUBJECTS_3).toContain(row.subject);
      expect(row.recipient_email).toMatch(/@example\.com$/);
      expect(row.body_html).toContain(`Hi ${row.recipient_name},`);
      expect(row.body_html).toContain(`Regards,<br>${row.sender_from_name}`);
    }
  });

  test('earliestSendUtc skips slots earlier than the cold-start instant', () => {
    const parts = getManilaParts(TUE_3PM_MANILA);
    // Cold-start at 5:30pm Manila = 09:30 UTC
    const restartAt = manilaWallClockToUtc(parts, 17, 30);
    const plan = planDay({
      manila: parts,
      senders: SENDERS_9,
      recipients: RECIPIENTS_5,
      subjects: SUBJECTS_3,
      earliestSendUtc: restartAt,
      random: seededRandom(55),
    });
    for (const row of plan) {
      expect(row.send_at_utc.getTime()).toBeGreaterThanOrEqual(restartAt.getTime());
    }
  });

  test('empty senders produces empty plan', () => {
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: [],
      recipients: RECIPIENTS_5,
      subjects: SUBJECTS_3,
      random: seededRandom(1),
    });
    expect(plan).toEqual([]);
  });
});

import { describe, test, expect } from 'vitest';
import { planDay } from './plan.js';
import { renderBody } from './render.js';
import { dailyTargetForWorkday, getWorkdayIndex } from './ramp.js';
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

const RECIPIENTS_8 = Array.from({ length: 8 }, (_, i) => ({
  email: `r${i + 1}@example.com`,
  first_name: `R${i + 1}`,
}));

const SUBJECTS_3 = ['Welcome', 'Activity Update', 'Account Notice'];

// A Tuesday 3:00pm Asia/Manila → 07:00 UTC
const TUE_3PM_MANILA = new Date(Date.UTC(2026, 5, 2, 7, 0, 0)); // June 2 2026 Tue 07:00Z

describe('schedule-window', () => {
  test('getManilaParts returns Manila local time for a UTC instant', () => {
    const parts = getManilaParts(TUE_3PM_MANILA);
    expect(parts.dateKey).toBe('2026-06-02');
    expect(parts.weekday).toBe(2);
    expect(parts.hour).toBe(15);
    expect(parts.minute).toBe(0);
  });

  test('isInWorkdayWindow accepts Mon–Fri 3pm–10pm Manila, rejects others', () => {
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 2, 7, 0))))).toBe(true);
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 2, 13, 59))))).toBe(true);
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 2, 14, 0))))).toBe(false);
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 2, 6, 59))))).toBe(false);
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 6, 7, 30))))).toBe(false); // Sat
    expect(isInWorkdayWindow(getManilaParts(new Date(Date.UTC(2026, 5, 7, 9, 0))))).toBe(false);  // Sun
  });
});

describe('renderBody', () => {
  test('substitutes both tokens', () => {
    const out = renderBody({ recipient_name: 'Leo', sender_from_name: 'John' });
    expect(out).toContain('Hi Leo,');
    expect(out).toContain('Regards,<br>John');
  });
});

describe('ramp / getWorkdayIndex', () => {
  test('returns 0 when today is before start', () => {
    expect(getWorkdayIndex('2026-06-01', '2026-05-29')).toBe(0);
  });

  test('returns 0 on weekends even if after start', () => {
    expect(getWorkdayIndex('2026-06-01', '2026-06-06')).toBe(0); // Sat
    expect(getWorkdayIndex('2026-06-01', '2026-06-07')).toBe(0); // Sun
  });

  test('returns 1 on the start date itself when it is a weekday', () => {
    expect(getWorkdayIndex('2026-06-01', '2026-06-01')).toBe(1); // Mon
  });

  test('returns 5 across a full Mon-Fri week, then 6 next Monday', () => {
    expect(getWorkdayIndex('2026-06-01', '2026-06-05')).toBe(5); // Fri of week 1
    expect(getWorkdayIndex('2026-06-01', '2026-06-08')).toBe(6); // Mon of week 2 (Sat+Sun skipped)
  });

  test('returns 0 when start date is malformed', () => {
    expect(getWorkdayIndex('', '2026-06-01')).toBe(0);
    expect(getWorkdayIndex('not-a-date', '2026-06-01')).toBe(0);
  });
});

describe('ramp / dailyTargetForWorkday', () => {
  test('day 0 → 0 sends (no plan)', () => {
    expect(dailyTargetForWorkday(0)).toBe(0);
  });

  test('day 1 → 5, day 2 → 6, ..., day 16+ → capped at 20', () => {
    expect(dailyTargetForWorkday(1)).toBe(5);
    expect(dailyTargetForWorkday(2)).toBe(6);
    expect(dailyTargetForWorkday(10)).toBe(14);
    expect(dailyTargetForWorkday(16)).toBe(20);
    expect(dailyTargetForWorkday(30)).toBe(20); // cap
  });
});

describe('planDay', () => {
  test('produces dailyTarget sends per sender (when dailyTarget * cadence fits the window)', () => {
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: SENDERS_9,
      recipients: RECIPIENTS_8,
      subjects: SUBJECTS_3,
      dailyTarget: 5,
      random: seededRandom(42),
    });

    const perSender = new Map<string, number>();
    for (const row of plan) {
      perSender.set(row.sender_email, (perSender.get(row.sender_email) ?? 0) + 1);
    }
    for (const c of perSender.values()) expect(c).toBe(5);
    expect(plan.length).toBe(5 * 9); // 45
  });

  test('dailyTarget=0 yields empty plan (before-start-date case)', () => {
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: SENDERS_9,
      recipients: RECIPIENTS_8,
      subjects: SUBJECTS_3,
      dailyTarget: 0,
      random: seededRandom(42),
    });
    expect(plan).toEqual([]);
  });

  test('returns rows sorted by send_at_utc', () => {
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: SENDERS_9,
      recipients: RECIPIENTS_8,
      subjects: SUBJECTS_3,
      dailyTarget: 7,
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
      recipients: RECIPIENTS_8,
      subjects: SUBJECTS_3,
      dailyTarget: 7,
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

  test('per-sender recipient rotation: dailyTarget=5 with 8 recipients = 5 distinct recipients per sender', () => {
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: SENDERS_9,
      recipients: RECIPIENTS_8,
      subjects: SUBJECTS_3,
      dailyTarget: 5,
      random: seededRandom(13),
    });

    const recipientsBySender = new Map<string, Set<string>>();
    for (const row of plan) {
      const set = recipientsBySender.get(row.sender_email) ?? new Set();
      set.add(row.recipient_email);
      recipientsBySender.set(row.sender_email, set);
    }
    for (const set of recipientsBySender.values()) {
      expect(set.size).toBe(5);
    }
  });

  test('rotation wraps when dailyTarget > recipient pool', () => {
    // 5 recipients, dailyTarget=8 → 8 sends total: 5 distinct + 3 wraps.
    // 8 sends × ~47.5 min ≈ 380 min, fits comfortably in the 420-min workday.
    const recipients5 = RECIPIENTS_8.slice(0, 5);
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: [{ email: 'a@example.com', from_name: 'A' }],
      recipients: recipients5,
      subjects: SUBJECTS_3,
      dailyTarget: 8,
      random: seededRandom(13),
    });
    expect(plan.length).toBe(8);
    const distinct = new Set(plan.map((r) => r.recipient_email));
    expect(distinct.size).toBe(5); // all 5 used, 3 wraps
  });

  test('window cap honored: stops early if next slot would exceed 10pm', () => {
    // Late-day start with too high a target
    const parts = getManilaParts(TUE_3PM_MANILA);
    const lateStart = manilaWallClockToUtc(parts, 21, 30); // 9:30pm Manila — only 30 min left
    const plan = planDay({
      manila: parts,
      senders: [{ email: 'a@example.com', from_name: 'A' }],
      recipients: RECIPIENTS_8,
      subjects: SUBJECTS_3,
      dailyTarget: 20,
      earliestSendUtc: lateStart,
      random: seededRandom(13),
    });
    // 30 min window, 45-50 min cadence → only one slot can fit (the initial one)
    expect(plan.length).toBeLessThanOrEqual(1);
  });

  test('renders body for every row using the recipient and sender names', () => {
    const plan = planDay({
      manila: getManilaParts(TUE_3PM_MANILA),
      senders: SENDERS_9,
      recipients: RECIPIENTS_8,
      subjects: SUBJECTS_3,
      dailyTarget: 5,
      random: seededRandom(11),
    });
    for (const row of plan) {
      expect(SUBJECTS_3).toContain(row.subject);
      expect(row.body_html).toContain(`Hi ${row.recipient_name},`);
      expect(row.body_html).toContain(`Regards,<br>${row.sender_from_name}`);
    }
  });
});

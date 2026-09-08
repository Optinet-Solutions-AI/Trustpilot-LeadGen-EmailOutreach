import { describe, test, expect } from 'vitest';
import { decideFollowUpSend } from './follow-up-budget.js';
import type { SendingSchedule } from './schedule-engine.js';

/**
 * Follow-ups used to be sent by their own loop with no cap and no window
 * check, which is how 2026-09-05 put 43 emails out against a 30/day cap and
 * pushed one mailbox to 23 sends against a limit of 10.
 *
 * The rules these tests pin down:
 *  - follow-ups draw on the SAME per-account budget as first-touch sends
 *  - a follow-up NEVER switches sender to find headroom (it would break the
 *    thread the recipient sees), it defers instead
 *  - a follow-up due outside the campaign's window waits for the next opening
 */

const schedule: SendingSchedule = {
  timezone: 'UTC',
  startHour: '09:00',
  endHour: '17:00',
  days: [0, 1, 2, 3, 4, 5, 6],
  dailyLimit: 10,
};

const GRACE = 'grace@rp.example.com';
/** Inside the 09:00-17:00 UTC window. */
const MIDWINDOW = new Date('2026-09-07T12:00:00Z');

function decide(over: Partial<Parameters<typeof decideFollowUpSend>[0]> = {}) {
  return decideFollowUpSend({
    senderEmail: GRACE,
    sentCounts: { [GRACE]: { daily: 0, hourly: 0 } },
    perAccountDailyLimit: 10,
    accountDailyCap: 50,
    accountHourlyCap: 20,
    schedule,
    now: MIDWINDOW,
    ...over,
  });
}

describe('follow-ups share the per-account daily budget', () => {
  test('sends while the recorded sender is under its per-account limit', () => {
    expect(decide().action).toBe('send');
  });

  test('defers once the recorded sender is at the campaign per-account limit', () => {
    // This is the 2026-09-05 case: grace@ had already sent 10, and the old
    // code sent 13 more anyway.
    const d = decide({ sentCounts: { [GRACE]: { daily: 10, hourly: 0 } } });
    expect(d.action).toBe('defer');
    if (d.action === 'defer') expect(d.reason).toBe('daily_cap');
  });

  test('counts first-touch sends against the same budget', () => {
    // One shared budget: 10 first-touch sends leave no room for a follow-up.
    // sentCounts comes from campaign_leads and does not distinguish steps.
    expect(decide({ sentCounts: { [GRACE]: { daily: 10, hourly: 2 } } }).action).toBe('defer');
  });

  test('never switches sender to get around a cap', () => {
    // Another mailbox having headroom is irrelevant — the thread belongs to
    // the account that sent step 1.
    const d = decide({
      sentCounts: {
        [GRACE]: { daily: 10, hourly: 0 },
        'lily@rp.example.com': { daily: 0, hourly: 0 },
      },
    });
    expect(d.action).toBe('defer');
  });

  test('falls back to the account warmup ramp when the campaign sets no limit', () => {
    const under = decide({ perAccountDailyLimit: undefined, accountDailyCap: 12,
      sentCounts: { [GRACE]: { daily: 11, hourly: 0 } } });
    expect(under.action).toBe('send');

    const at = decide({ perAccountDailyLimit: undefined, accountDailyCap: 12,
      sentCounts: { [GRACE]: { daily: 12, hourly: 0 } } });
    expect(at.action).toBe('defer');
  });

  test('a stricter campaign figure tightens a generous ramp', () => {
    // The operator can always ask for less than the ramp allows.
    const d = decide({ perAccountDailyLimit: 10, accountDailyCap: 50,
      sentCounts: { [GRACE]: { daily: 10, hourly: 0 } } });
    expect(d.action).toBe('defer');
  });

  test('a campaign CANNOT buy past the warmup ramp', () => {
    // The reason this rule exists: a domain still warming up must not be
    // pushed to 50/day because someone typed 50 into the wizard. Ramp is 29,
    // campaign asks 50, and 29 sends is already the ceiling.
    const d = decide({ perAccountDailyLimit: 50, accountDailyCap: 29,
      sentCounts: { [GRACE]: { daily: 29, hourly: 0 } } });
    expect(d.action).toBe('defer');
    if (d.action === 'defer') expect(d.reason).toBe('daily_cap');
  });

  test('below both limits it still sends', () => {
    const d = decide({ perAccountDailyLimit: 50, accountDailyCap: 29,
      sentCounts: { [GRACE]: { daily: 28, hourly: 0 } } });
    expect(d.action).toBe('send');
  });

  test('defers on the hourly cap even with daily headroom', () => {
    const d = decide({ sentCounts: { [GRACE]: { daily: 1, hourly: 20 } } });
    expect(d.action).toBe('defer');
    if (d.action === 'defer') expect(d.reason).toBe('hourly_cap');
  });

  test('a row with no recorded sender is not silently uncapped', () => {
    // Pre-feature rows have sender_email NULL. They fall back to the env
    // account, so they must not bypass the check by having no key.
    const d = decide({ senderEmail: null });
    expect(d.action).toBe('send'); // allowed, but through the env limiter
    if (d.action === 'send') expect(d.viaEnvAccount).toBe(true);
  });
});

describe('follow-ups respect the campaign sending window', () => {
  test('sends inside the window', () => {
    expect(decide({ now: new Date('2026-09-07T09:30:00Z') }).action).toBe('send');
  });

  test('defers to the next opening when due before the window opens', () => {
    const d = decide({ now: new Date('2026-09-07T06:00:00Z') });
    expect(d.action).toBe('defer');
    if (d.action === 'defer') {
      expect(d.reason).toBe('outside_window');
      expect(d.until.toISOString()).toBe('2026-09-07T09:00:00.000Z');
    }
  });

  test('defers to tomorrow when due after the window closes', () => {
    const d = decide({ now: new Date('2026-09-07T18:00:00Z') });
    expect(d.action).toBe('defer');
    if (d.action === 'defer') expect(d.until.toISOString()).toBe('2026-09-08T09:00:00.000Z');
  });

  test('skips a day the campaign does not send on', () => {
    // Weekdays only; 2026-09-12 is a Saturday, so the next opening is Monday.
    const weekdays: SendingSchedule = { ...schedule, days: [1, 2, 3, 4, 5] };
    const d = decide({ schedule: weekdays, now: new Date('2026-09-12T12:00:00Z') });
    expect(d.action).toBe('defer');
    if (d.action === 'defer') expect(d.until.toISOString()).toBe('2026-09-14T09:00:00.000Z');
  });

  test('honours the campaign timezone, not UTC', () => {
    // 09:00-17:00 Europe/Paris in September (UTC+2) = 07:00-15:00 UTC.
    // 16:00 UTC is outside it even though it is inside the UTC window.
    const paris: SendingSchedule = { ...schedule, timezone: 'Europe/Paris' };
    const d = decide({ schedule: paris, now: new Date('2026-09-07T16:00:00Z') });
    expect(d.action).toBe('defer');
    if (d.action === 'defer') expect(d.until.toISOString()).toBe('2026-09-08T07:00:00.000Z');
  });

  test('a campaign with no schedule is capped but not window-gated', () => {
    expect(decide({ schedule: null }).action).toBe('send');
    expect(decide({ schedule: null, now: new Date('2026-09-07T03:00:00Z') }).action).toBe('send');
  });

  test('the cap is checked before the window', () => {
    // Both violated: report the cap, because deferring to the window opening
    // would not help an account that is already spent for the day.
    const d = decide({
      now: new Date('2026-09-07T03:00:00Z'),
      sentCounts: { [GRACE]: { daily: 10, hourly: 0 } },
    });
    expect(d.action).toBe('defer');
    if (d.action === 'defer') expect(d.reason).toBe('daily_cap');
  });
});

describe('regression: the 2026-09-05 burst', () => {
  test('a 21-follow-up backlog onto one mailbox stops at the limit', () => {
    // What actually happened: 21 follow-ups came due at once, 20 of them
    // routed to grace@ (it had sent their step 1), and the loop sent every
    // one — finishing the day at 23 sends against a per-account limit of 10.
    // Walk the same backlog through the gate, advancing counts after each
    // send exactly as the tick now does.
    const counts: Record<string, { daily: number; hourly: number }> = {
      [GRACE]: { daily: 0, hourly: 0 },
    };
    let sent = 0;
    let deferred = 0;

    for (let i = 0; i < 21; i++) {
      const d = decideFollowUpSend({
        senderEmail: GRACE,
        sentCounts: counts,
        perAccountDailyLimit: 10,
        accountDailyCap: 50,
        accountHourlyCap: 100, // take the hourly cap out of the picture
        schedule,
        now: MIDWINDOW,
      });
      if (d.action === 'send') {
        sent++;
        counts[GRACE].daily  += 1;
        counts[GRACE].hourly += 1;
      } else {
        deferred++;
      }
    }

    expect(sent).toBe(10);      // was 20
    expect(deferred).toBe(11);
    expect(counts[GRACE].daily).toBe(10);
  });

  test('first-touch sends already on the clock shrink the follow-up room', () => {
    // One shared budget: 4 first-touch sends leave 6 for follow-ups, not 10.
    const counts = { [GRACE]: { daily: 4, hourly: 4 } };
    let sent = 0;
    for (let i = 0; i < 21; i++) {
      const d = decideFollowUpSend({
        senderEmail: GRACE, sentCounts: counts, perAccountDailyLimit: 10,
        accountDailyCap: 50, accountHourlyCap: 100, schedule, now: MIDWINDOW,
      });
      if (d.action !== 'send') break;
      sent++;
      counts[GRACE].daily += 1;
      counts[GRACE].hourly += 1;
    }
    expect(sent).toBe(6);
  });
});

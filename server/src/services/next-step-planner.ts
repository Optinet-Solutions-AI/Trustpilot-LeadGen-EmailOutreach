/**
 * When a follow-up should actually be due.
 *
 * It used to be `now + delay_days * 24h`, computed with no knowledge of what
 * was already booked. A batch sent at 20:00 therefore all came due at 20:00
 * three days later — on 2026-09-11 that was 27 follow-ups stacked on one hour
 * of a day that already held 30. The send gate held the line, so nothing
 * over-sent, but the stored plan was wrong and the calendar with it, and it
 * re-bunched within days of every manual re-pace.
 *
 * The delay is now a SOONEST rather than an exact date: the follow-up lands on
 * the first allowed day from there that still has room, spread inside the
 * campaign's window. Same rules the re-pacer applies, so the two agree.
 */

import {
  isWithinSendingWindow, nextWindowOpening, localDayKey, type SendingSchedule,
} from './schedule-engine.js';

/** Emails already booked per local day, keyed YYYY-MM-DD. Mutated on booking. */
export type DayLoad = Map<string, number>;

export interface PlanNextStepInput {
  load: DayLoad;
  schedule: SendingSchedule;
  /** The ideal date — usually now + delay_days. Never scheduled before `now`. */
  earliest: Date;
  /** Shared daily ceiling across every mailbox and campaign. */
  capacityPerDay: number;
  now?: Date;
}

const HOUR_MS = 3_600_000;

/**
 * Reserve a slot and return it. The load map is incremented, so calling this
 * repeatedly within one tick spreads a batch instead of stacking it — which
 * is the specific failure this exists to prevent.
 */
export function planNextStepAt({
  load, schedule, earliest, capacityPerDay, now = new Date(),
}: PlanNextStepInput): Date {
  const from = new Date(Math.max(earliest.getTime(), now.getTime()));

  let cursor = isWithinSendingWindow(schedule, from)
    ? from
    : nextWindowOpening(schedule, from);

  let dayKey = localDayKey(cursor, schedule.timezone);
  for (let guard = 0; (load.get(dayKey) ?? 0) >= capacityPerDay; guard++) {
    if (guard > 400) {
      throw new Error('planNextStepAt: no day with capacity within a year');
    }
    cursor = nextWindowOpening(schedule, nextLocalDayStart(cursor, schedule.timezone));
    dayKey = localDayKey(cursor, schedule.timezone);
  }

  const index = load.get(dayKey) ?? 0;
  load.set(dayKey, index + 1);
  return placeInWindow(schedule, cursor, index, capacityPerDay);
}

/**
 * The first instant strictly inside the NEXT local day. Stepping in hours is
 * offset- and DST-agnostic; deriving it from a UTC midnight lands on the
 * PREVIOUS local day in any timezone behind UTC and can loop forever.
 */
function nextLocalDayStart(at: Date, timezone: string): Date {
  const startKey = localDayKey(at, timezone);
  let t = at.getTime();
  for (let i = 0; i < 48; i++) {
    t += HOUR_MS;
    if (localDayKey(new Date(t), timezone) !== startKey) return new Date(t);
  }
  return new Date(at.getTime() + 24 * HOUR_MS);
}

/** The instant a given local day's window opens. */
function dayWindowOpening(schedule: SendingSchedule, within: Date): Date {
  const [startH, startM] = schedule.startHour.split(':').map(Number);
  const key = localDayKey(within, schedule.timezone);
  let candidate = new Date(`${key}T00:00:00Z`);
  for (let i = 0; i < 48 && localDayKey(candidate, schedule.timezone) !== key; i++) {
    candidate = new Date(candidate.getTime() + HOUR_MS);
  }
  return nextWindowOpening(schedule, new Date(candidate.getTime() + (startH * 60 + startM) * 60_000));
}

/** Spread the nth placement across the window rather than stacking them. */
function placeInWindow(
  schedule: SendingSchedule, cursor: Date, index: number, capacityPerDay: number,
): Date {
  const [startH, startM] = schedule.startHour.split(':').map(Number);
  const [endH, endM] = schedule.endHour.split(':').map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  const windowMinutes = endMin > startMin ? endMin - startMin : 24 * 60 - startMin + endMin;

  const opening = dayWindowOpening(schedule, cursor);
  const windowEnd = opening.getTime() + windowMinutes * 60_000;

  // Spread across what is LEFT of the window, not the whole of it. When the
  // ideal time lands mid-window, measuring from the opening puts the early
  // slots before the cursor, where they all clamp up to it and collide on one
  // timestamp — reproducing the very stacking this is meant to prevent.
  const effectiveStart = Math.max(opening.getTime(), cursor.getTime());
  const effectiveMinutes = Math.max(1, Math.floor((windowEnd - effectiveStart) / 60_000));

  const slot = Math.max(1, Math.floor(effectiveMinutes / Math.max(1, capacityPerDay)));
  const jitter = slot > 2 ? Math.floor(Math.random() * (slot - 1)) : 0;
  const target = effectiveStart + (index * slot + jitter) * 60_000;

  return new Date(Math.min(target, windowEnd - 60_000));
}

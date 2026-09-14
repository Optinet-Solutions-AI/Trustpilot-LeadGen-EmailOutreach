/**
 * Re-pace an existing queue so the stored plan matches what can actually send.
 *
 * The queue was built when follow-ups did not count against the daily cap, so
 * it holds days far over the real ceiling — 53 follow-ups on 2026-09-09, 64 on
 * the 10th, against 30. The send-time gate now holds those back and drips them
 * out, but the QUEUE still claims they go on those days. An operator planning
 * from a calendar that overstates a day is exactly the failure this work set
 * out to remove, so the times themselves get rewritten.
 *
 * Rules the rewrite obeys:
 *  - never move a row EARLIER than it was already scheduled (a lead promised
 *    three days of breathing room keeps them)
 *  - never place anything in the past
 *  - never exceed the day's capacity, counting first touches and follow-ups
 *    together, because they share one budget
 *  - only place inside the campaign's own sending window and active days
 *  - preserve order: whatever was due first stays first
 */

import {
  isWithinSendingWindow, nextWindowOpening, localDayKey, budgetDayEnd,
  windowOpeningOnLocalDay, BUDGET_TIMEZONE, type SendingSchedule,
} from './schedule-engine.js';

export interface RepaceItem {
  id: string;
  kind: 'first_touch' | 'follow_up';
  /** Where it currently sits. */
  at: Date;
  /** The owning campaign's window — placements must land inside it. */
  schedule: SendingSchedule;
  /**
   * The campaign's follow-up steps. A first touch placed here also books the
   * days its own follow-ups will need, so a re-pace cannot pack every day with
   * first touches and leave the follow-ups nowhere to go but the far end of
   * the run. The reservations are not returned and never written; they exist
   * to leave the right gaps behind.
   */
  followUpSteps?: Array<{ stepNumber: number; delayDays: number }>;
}

export interface RepaceResult {
  id: string;
  kind: RepaceItem['kind'];
  from: Date;
  to: Date;
  /**
   * The budget day this placement was charged to (YYYY-MM-DD in
   * BUDGET_TIMEZONE). It must equal the day `to` falls on: when the two
   * diverge, a day is counted at capacity while more mail actually goes out on
   * it, which is how a re-paced queue still showed 65 against a cap of 60.
   */
  budgetDay: string;
}

export interface RepaceOptions {
  /**
   * Emails per day across ALL mailboxes and ALL campaigns — one shared budget,
   * the same one the send-time gate enforces.
   */
  capacityPerDay: number;
  /** Nothing is placed before this. Defaults to now. */
  from?: Date;
  /**
   * What each day has ALREADY sent, keyed by local day (YYYY-MM-DD).
   *
   * Without this the placer starts every day at zero and happily fills today
   * to capacity on top of whatever went out this morning — which is exactly
   * how a re-pace on 2026-09-10 left the day at 31 against a cap of 30. Sent
   * mail is spent budget and has to be counted before anything new is placed.
   */
  alreadySent?: Record<string, number>;
}

const DAY_MS = 86_400_000;

export function repaceQueue(
  items: RepaceItem[],
  { capacityPerDay, from = new Date(), alreadySent = {} }: RepaceOptions,
): RepaceResult[] {
  if (!Number.isFinite(capacityPerDay) || capacityPerDay < 1) {
    throw new Error(`repaceQueue: capacityPerDay must be at least 1, got ${capacityPerDay}`);
  }
  if (items.length === 0) return [];

  // Whatever was due first keeps its priority.
  const ordered = [...items].sort((a, b) => a.at.getTime() - b.at.getTime());

  /**
   * Placements committed to each day. Seeded with what the day has already
   * sent, so spent budget is never handed out twice.
   */
  const used = new Map<string, number>(
    Object.entries(alreadySent).map(([day, n]) => [day, Math.max(0, n)]),
  );
  const results: RepaceResult[] = [];

  /**
   * Take the first slot at or after `earliest` that still has room, and
   * return when it lands. Used both for the row being re-paced and for the
   * days its follow-ups will need.
   */
  const claim = (
    schedule: SendingSchedule, earliest: Date, label: string,
  ): { to: Date; dayKey: string } => {
    let cursor = isWithinSendingWindow(schedule, earliest)
      ? earliest
      : nextWindowOpening(schedule, earliest);

    // Walk forward to the first allowed day that still has room.
    let guard = 0;
    // Counted on one timeline — see BUDGET_TIMEZONE. Keying this by the
    // campaign's own timezone handed every zone a private 60/day.
    let dayKey = localDayKey(cursor, BUDGET_TIMEZONE);
    while ((used.get(dayKey) ?? 0) >= capacityPerDay) {
      if (++guard > 400) {
        throw new Error(`repaceQueue: could not place ${label} within a year`);
      }
      // Step into the next LOCAL day, then forward to its window opening.
      // Monotonic by construction, so a full day can never be revisited.
      const probe = nextLocalDayStart(cursor, schedule.timezone);
      const advanced = nextWindowOpening(schedule, probe);
      if (advanced.getTime() <= cursor.getTime()) {
        throw new Error(`repaceQueue: schedule for ${label} does not advance`);
      }
      cursor = advanced;
      dayKey = localDayKey(cursor, BUDGET_TIMEZONE);
    }

    // Slot position uses the day's running total so prior sends do not get
    // the same minute, but stays inside the window via the clamp below.
    const index = used.get(dayKey) ?? 0;
    used.set(dayKey, index + 1);
    return { to: placeInWindow(schedule, cursor, index, capacityPerDay), dayKey };
  };

  for (const item of ordered) {
    // A row may not move earlier than it already was, nor into the past.
    const earliest = new Date(Math.max(item.at.getTime(), from.getTime()));
    const { to, dayKey } = claim(item.schedule, earliest, item.id);
    results.push({ id: item.id, kind: item.kind, from: item.at, to, budgetDay: dayKey });

    // Book the days this prospect's own follow-ups will need, now, while they
    // are still free. Without this a re-pace fills every day with first
    // touches and every follow-up queues behind the whole run.
    const steps = [...(item.followUpSteps ?? [])].sort((a, b) => a.stepNumber - b.stepNumber);
    if (item.kind !== 'first_touch' || steps.length === 0) continue;
    let cursor = to;
    for (const step of steps) {
      cursor = claim(
        item.schedule,
        new Date(cursor.getTime() + step.delayDays * DAY_MS),
        `${item.id} step ${step.stepNumber}`,
      ).to;
    }
  }

  return results;
}

/**
 * The first instant strictly inside the NEXT local day after `at`.
 *
 * Deriving this by constructing UTC midnight from the day key is wrong for any
 * timezone behind UTC: `2026-09-15T00:00Z` is still 2026-09-14 in New York, so
 * the cursor could land back on the day it was trying to leave and loop until
 * the guard fired. Stepping in hours until the local date actually changes is
 * offset- and DST-agnostic.
 */
function nextLocalDayStart(at: Date, timezone: string): Date {
  const startKey = localDayKey(at, timezone);
  let t = at.getTime();
  for (let i = 0; i < 48; i++) {
    t += 3_600_000;
    if (localDayKey(new Date(t), timezone) !== startKey) return new Date(t);
  }
  return new Date(at.getTime() + DAY_MS);
}

/** The instant a given local day's window opens. */
function dayWindowOpening(schedule: SendingSchedule, within: Date): Date {
  const [startH, startM] = schedule.startHour.split(':').map(Number);
  const key = localDayKey(within, schedule.timezone);
  // Walk back from the probe to that local day's start hour, then let
  // nextWindowOpening settle it onto an allowed day.
  let candidate = new Date(`${key}T00:00:00Z`);
  for (let i = 0; i < 48 && localDayKey(candidate, schedule.timezone) !== key; i++) {
    candidate = new Date(candidate.getTime() + 3_600_000);
  }
  const minutes = startH * 60 + startM;
  return nextWindowOpening(schedule, new Date(candidate.getTime() + minutes * 60_000));
}

/**
 * Spread the nth placement across the day's window rather than stacking them.
 * The old follow-up loop fired 20 inside 30 seconds; that burst pattern is a
 * deliverability signal in its own right, quite apart from the volume.
 */
function placeInWindow(
  schedule: SendingSchedule,
  cursor: Date,
  index: number,
  capacityPerDay: number,
): Date {
  const [startH, startM] = schedule.startHour.split(':').map(Number);
  const [endH, endM] = schedule.endHour.split(':').map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  const windowMinutes = endMin > startMin ? endMin - startMin : 24 * 60 - startMin + endMin;

  // Offsets are measured from the DAY'S OPENING, not from the cursor: a row
  // that was already mid-window would otherwise have the slot offset added on
  // top of its existing time and overflow past the window end.
  const opening = windowOpeningOnLocalDay(schedule, cursor);
  const windowEnd = opening.getTime() + windowMinutes * 60_000;

  // The slot was counted against ONE budget day, so it has to be spent inside
  // that day. A window can cross the boundary (16:00-23:59 New York closes at
  // 03:59 UTC the next day), and spilling over it means a day is counted at
  // capacity while more mail actually goes out on it.
  const effectiveStart = Math.max(opening.getTime(), cursor.getTime());
  const effectiveEnd = Math.min(windowEnd, budgetDayEnd(cursor).getTime() + 60_000);
  const effectiveMinutes = Math.max(1, Math.floor((effectiveEnd - effectiveStart) / 60_000));

  // Slot width so a full day's capacity fits, with a little jitter inside the
  // slot — a perfectly even cadence reads as machinery.
  const slot = Math.max(1, Math.floor(effectiveMinutes / Math.max(1, capacityPerDay)));
  const jitter = slot > 2 ? Math.floor(Math.random() * (slot - 1)) : 0;
  const offsetMinutes = index * slot + jitter;

  const target = effectiveStart + offsetMinutes * 60_000;
  const clamped = Math.min(Math.max(target, cursor.getTime()), effectiveEnd - 60_000);
  return new Date(Math.max(clamped, effectiveStart));
}

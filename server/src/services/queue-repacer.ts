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
  isWithinSendingWindow, nextWindowOpening, localDayKey, type SendingSchedule,
} from './schedule-engine.js';

export interface RepaceItem {
  id: string;
  kind: 'first_touch' | 'follow_up';
  /** Where it currently sits. */
  at: Date;
  /** The owning campaign's window — placements must land inside it. */
  schedule: SendingSchedule;
}

export interface RepaceResult {
  id: string;
  kind: RepaceItem['kind'];
  from: Date;
  to: Date;
}

export interface RepaceOptions {
  /**
   * Emails per day across ALL mailboxes and ALL campaigns — one shared budget,
   * the same one the send-time gate enforces.
   */
  capacityPerDay: number;
  /** Nothing is placed before this. Defaults to now. */
  from?: Date;
}

const DAY_MS = 86_400_000;

export function repaceQueue(
  items: RepaceItem[],
  { capacityPerDay, from = new Date() }: RepaceOptions,
): RepaceResult[] {
  if (!Number.isFinite(capacityPerDay) || capacityPerDay < 1) {
    throw new Error(`repaceQueue: capacityPerDay must be at least 1, got ${capacityPerDay}`);
  }
  if (items.length === 0) return [];

  // Whatever was due first keeps its priority.
  const ordered = [...items].sort((a, b) => a.at.getTime() - b.at.getTime());

  /** Placements already committed to each day, and where in the window. */
  const used = new Map<string, number>();
  const results: RepaceResult[] = [];

  for (const item of ordered) {
    // A row may not move earlier than it already was, nor into the past.
    const earliest = new Date(Math.max(item.at.getTime(), from.getTime()));
    let cursor = isWithinSendingWindow(item.schedule, earliest)
      ? earliest
      : nextWindowOpening(item.schedule, earliest);

    // Walk forward to the first allowed day that still has room.
    let guard = 0;
    let dayKey = localDayKey(cursor, item.schedule.timezone);
    while ((used.get(dayKey) ?? 0) >= capacityPerDay) {
      if (++guard > 400) {
        throw new Error(`repaceQueue: could not place ${item.id} within a year`);
      }
      // Step into the next LOCAL day, then forward to its window opening.
      // Monotonic by construction, so a full day can never be revisited.
      const probe = nextLocalDayStart(cursor, item.schedule.timezone);
      const advanced = nextWindowOpening(item.schedule, probe);
      if (advanced.getTime() <= cursor.getTime()) {
        throw new Error(`repaceQueue: schedule for ${item.id} does not advance`);
      }
      cursor = advanced;
      dayKey = localDayKey(cursor, item.schedule.timezone);
    }

    const index = used.get(dayKey) ?? 0;
    used.set(dayKey, index + 1);

    results.push({
      id: item.id,
      kind: item.kind,
      from: item.at,
      to: placeInWindow(item.schedule, cursor, index, capacityPerDay),
    });
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
  const opening = dayWindowOpening(schedule, cursor);
  const windowEnd = opening.getTime() + windowMinutes * 60_000;

  // Slot width so a full day's capacity fits, with a little jitter inside the
  // slot — a perfectly even cadence reads as machinery.
  const slot = Math.max(1, Math.floor(windowMinutes / Math.max(1, capacityPerDay)));
  const jitter = slot > 2 ? Math.floor(Math.random() * (slot - 1)) : 0;
  const offsetMinutes = index * slot + jitter;

  const target = opening.getTime() + offsetMinutes * 60_000;
  // Never before the cursor (which already respects "not earlier than before"),
  // and never at or past the window's close.
  const clamped = Math.min(Math.max(target, cursor.getTime()), windowEnd - 60_000);
  return new Date(clamped);
}

/**
 * Pure helpers for the daily volume ramp.
 *
 * Workday index = number of Mon-Fri days from COLLEAGUE_WARMUP_START_DATE
 * (inclusive) up to and including today. Returns 0 when today is before
 * the start date, which the scheduler treats as "do nothing today".
 */

import { VOLUME_RAMP } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param startDateKey YYYY-MM-DD in Asia/Manila local (the configured Day 1).
 * @param todayDateKey YYYY-MM-DD in Asia/Manila local for the current tick.
 * @returns 1-indexed workday number, or 0 when today is before start OR not a Mon-Fri.
 *          (Saturday/Sunday between start and today are skipped in the count.)
 */
export function getWorkdayIndex(startDateKey: string, todayDateKey: string): number {
  if (!startDateKey || !todayDateKey) return 0;

  const start = parseManilaDateKey(startDateKey);
  const today = parseManilaDateKey(todayDateKey);
  if (!start || !today) return 0;
  if (today.getTime() < start.getTime()) return 0;

  // today must itself be a weekday (Mon-Fri) to count
  const todayDow = today.getUTCDay();
  if (todayDow < 1 || todayDow > 5) return 0;

  let idx = 0;
  for (let t = start.getTime(); t <= today.getTime(); t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow >= 1 && dow <= 5) idx++;
  }
  return idx;
}

/** YYYY-MM-DD → UTC midnight Date. Returns null on bad input. */
function parseManilaDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const [_, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** Daily target = base + (workdayIndex-1) * step, capped at max. 0 if idx <= 0. */
export function dailyTargetForWorkday(workdayIndex: number): number {
  if (workdayIndex <= 0) return 0;
  const raw = VOLUME_RAMP.base + (workdayIndex - 1) * VOLUME_RAMP.step;
  return Math.min(raw, VOLUME_RAMP.max);
}

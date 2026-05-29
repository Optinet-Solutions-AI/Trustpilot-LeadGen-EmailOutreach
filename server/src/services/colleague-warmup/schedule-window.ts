/**
 * Pure helpers for the Asia/Manila workday window check.
 *
 * Using Intl.DateTimeFormat so we don't pull in a timezone library — Node 20+
 * ships full ICU, which has Asia/Manila baked in.
 */

import { WORKDAY } from './config.js';

export interface ManilaParts {
  /** YYYY-MM-DD in Manila local time */
  dateKey: string;
  /** 0=Sun, 1=Mon, …, 6=Sat — Manila local */
  weekday: number;
  /** 0..23 Manila local */
  hour: number;
  /** 0..59 Manila local */
  minute: number;
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: WORKDAY.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function getManilaParts(now: Date): ManilaParts {
  const parts = partsFormatter.formatToParts(now);
  let year = '', month = '', day = '', hour = '', minute = '', weekdayShort = '';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
    else if (p.type === 'hour') hour = p.value;
    else if (p.type === 'minute') minute = p.value;
    else if (p.type === 'weekday') weekdayShort = p.value;
  }
  // 'en-US' hour12:false formats midnight as '24' on some Node builds — normalize.
  const h = Number(hour) % 24;
  return {
    dateKey: `${year}-${month}-${day}`,
    weekday: WEEKDAY_INDEX[weekdayShort] ?? -1,
    hour: h,
    minute: Number(minute),
  };
}

export function isWeekday(parts: ManilaParts): boolean {
  return parts.weekday >= 1 && parts.weekday <= 5;
}

export function isInWorkdayWindow(parts: ManilaParts): boolean {
  if (!isWeekday(parts)) return false;
  return parts.hour >= WORKDAY.startHour && parts.hour < WORKDAY.endHourExclusive;
}

/**
 * Convert a Manila wall-clock time (today's date) to a UTC Date.
 * Used by the planner to anchor scheduled send times within the workday.
 */
export function manilaWallClockToUtc(parts: ManilaParts, hour: number, minute: number): Date {
  // We have the Manila date 'YYYY-MM-DD'; build a UTC Date that, when formatted
  // back in Asia/Manila, equals hh:mm on that date. Manila is fixed at UTC+8
  // (no DST), so the offset is constant.
  const [y, m, d] = parts.dateKey.split('-').map(Number);
  // Construct the equivalent UTC instant by subtracting 8h.
  return new Date(Date.UTC(y, m - 1, d, hour - 8, minute, 0, 0));
}

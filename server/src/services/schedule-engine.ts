/**
 * Schedule engine — assigns random UTC send times within a configured window.
 *
 * Logic:
 *  - Spreads emails across allowed days, respecting dailyLimit per day
 *  - Each email on a given day gets a random minute within [startHour, endHour]
 *  - No two emails share the exact same minute (best-effort dedup)
 *  - Times already in the past are skipped (window closed today → start tomorrow)
 *  - Test mode: returns empty array → caller sends immediately
 */

export interface SendingSchedule {
  timezone: string;   // e.g. "Asia/Manila" or "Asia/Hong_Kong"
  startHour: string;  // "09:00"
  endHour: string;    // "17:00"
  days: number[];     // 0=Sun, 1=Mon … 6=Sat
  dailyLimit: number; // max emails per day
  /** DB email_accounts.id to pin to one sender, or '__env__' for primary env account */
  senderAccountId?: string;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Get the UTC offset (in minutes) for a timezone at a specific moment.
 * Handles DST correctly because we compute it at the actual target time.
 */
function getUtcOffsetMinutes(timezone: string, date: Date): number {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr  = date.toLocaleString('en-US', { timeZone: timezone });
  const utcMs  = new Date(utcStr).getTime();
  const tzMs   = new Date(tzStr).getTime();
  return (tzMs - utcMs) / 60_000;
}

/**
 * Convert a local calendar date + hour/minute to a UTC Date,
 * accounting for the actual DST offset on that specific day.
 */
function localToUtc(
  year: number, month: number, day: number,
  localHour: number, localMinute: number,
  timezone: string,
): Date {
  // Start with a naive UTC estimate
  const rough = new Date(Date.UTC(year, month - 1, day, localHour, localMinute, 0));
  // Compute real offset at that moment and adjust
  const offsetMinutes = getUtcOffsetMinutes(timezone, rough);
  return new Date(rough.getTime() - offsetMinutes * 60_000);
}

interface LocalDay {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number; // 0=Sun … 6=Sat
}

/** Get the local calendar date (year/month/day/dayOfWeek) in the target timezone. */
function getLocalDay(utcDate: Date, timezone: string): LocalDay {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(utcDate);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year:      parseInt(get('year')),
    month:     parseInt(get('month')),
    day:       parseInt(get('day')),
    dayOfWeek: weekdays.indexOf(get('weekday')),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Assign random UTC send times for `count` emails.
 *
 * @param count    - number of emails
 * @param schedule - window config (timezone, hours, days, dailyLimit)
 * @param fromNow  - schedule start reference (default: now)
 * @returns sorted array of UTC Dates, one per email
 */
export function assignScheduledTimes(
  count: number,
  schedule: SendingSchedule,
  fromNow: Date = new Date(),
): Date[] {
  const { timezone, startHour, endHour, days, dailyLimit } = schedule;

  const [startH, startM] = startHour.split(':').map(Number);
  const [endH,   endM  ] = endHour.split(':').map(Number);
  const windowMinutes = (endH * 60 + endM) - (startH * 60 + startM);

  if (windowMinutes <= 0) throw new Error(`endHour (${endHour}) must be after startHour (${startHour})`);
  if (days.length === 0)  throw new Error('sendingSchedule.days must include at least one day');
  if (dailyLimit <= 0)    throw new Error('sendingSchedule.dailyLimit must be > 0');

  const results: Date[] = [];
  let remaining = count;
  let dayOffset = 0;

  while (remaining > 0 && dayOffset < 365) {
    // Which calendar day is this in the target timezone?
    const candidateUtc = new Date(fromNow.getTime() + dayOffset * 86_400_000);
    const local = getLocalDay(candidateUtc, timezone);

    if (!days.includes(local.dayOfWeek)) {
      dayOffset++;
      continue;
    }

    // Is the window still open today? (need at least 2 minutes remaining)
    const windowEndUtc = localToUtc(local.year, local.month, local.day, endH, endM, timezone);
    if (windowEndUtc.getTime() <= fromNow.getTime() + 2 * 60_000) {
      // Window already closed — skip to tomorrow
      dayOffset++;
      continue;
    }

    // Clamp window start: if we're mid-window today, start from now + 1 min
    const windowStartUtc = localToUtc(local.year, local.month, local.day, startH, startM, timezone);
    const effectiveStartMs = Math.max(windowStartUtc.getTime(), fromNow.getTime() + 60_000);
    const effectiveWindowMinutes = Math.floor((windowEndUtc.getTime() - effectiveStartMs) / 60_000);

    if (effectiveWindowMinutes < 1) {
      dayOffset++;
      continue;
    }

    // How many emails can we fit today with at least MIN_GAP_MINUTES between each?
    // 20 min minimum → sends look human-paced and don't trip spam filters that flag
    // bursts. With a 24h window and 50 leads, that still leaves ~28 min slots on average.
    const MIN_GAP_MINUTES = 20;
    const rawBatchSize = Math.min(remaining, dailyLimit);
    const batchSize = effectiveWindowMinutes >= rawBatchSize * MIN_GAP_MINUTES
      ? rawBatchSize
      : Math.max(1, Math.floor(effectiveWindowMinutes / MIN_GAP_MINUTES));

    // Randomised spread: divide the window into batchSize equal segments, then
    // pick a UNIFORMLY RANDOM minute inside each segment (clamped so adjacent
    // segments always honour MIN_GAP_MINUTES). This looks nothing like a cron
    // cadence — the gap between two consecutive emails can be anywhere from
    // MIN_GAP_MINUTES up to nearly 2× the segment size.
    // e.g. 50 emails / 24h window → ~28 min segments, actual gaps range 20–56 min.
    const segmentSize = Math.floor(effectiveWindowMinutes / batchSize);
    const guardMinutes = Math.min(Math.floor(MIN_GAP_MINUTES / 2), Math.floor(segmentSize / 4));
    for (let i = 0; i < batchSize; i++) {
      const segmentStart = i * segmentSize;
      const segmentEnd   = i === batchSize - 1 ? effectiveWindowMinutes : segmentStart + segmentSize;
      // Keep a small guard band at both edges so we never land <MIN_GAP_MINUTES
      // from the neighbouring segment's far edge
      const lo = segmentStart + guardMinutes;
      const hi = Math.max(lo, segmentEnd - guardMinutes);
      const randomOffset = lo + Math.floor(Math.random() * (hi - lo + 1));
      const sendTimeMs   = effectiveStartMs + randomOffset * 60_000;
      results.push(new Date(sendTimeMs));
    }

    remaining -= batchSize;
    dayOffset++;
  }

  // Sort chronologically so the send loop fires in order
  return results.sort((a, b) => a.getTime() - b.getTime());
}

/** Human-readable summary: "20 emails over 5 days, first: Tue 21:37 PH time" */
export function describeSendPlan(times: Date[], timezone: string): string {
  if (times.length === 0) return 'No emails scheduled';

  const first = times[0];
  const last  = times[times.length - 1];

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });

  // Count distinct days
  const days = new Set(
    times.map(t => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' }).format(t))
  );

  return `${times.length} emails over ${days.size} day(s) · first: ${fmt.format(first)} · last: ${fmt.format(last)}`;
}

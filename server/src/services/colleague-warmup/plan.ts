/**
 * Pure planner — given the day's senders, recipients, subjects, the Manila
 * workday window, and the daily per-sender target (from the ramp), produce
 * the full sequence of ScheduledSend rows for the day.
 *
 * The randomization is the only impurity. Pass a `random` function for
 * deterministic tests.
 *
 * Recipient rotation: each sender independently shuffles the recipient list
 * and pops in order. So a sender's `dailyTarget` sends go to DISTINCT
 * recipients (no repeats within the same sender's day, until rotation
 * exhausts the list and wraps).
 */

import { RECIPIENTS, SUBJECTS, SENDER_CADENCE_MS, WORKDAY } from './config.js';
import { renderBody } from './render.js';
import { manilaWallClockToUtc, type ManilaParts } from './schedule-window.js';

export type SendStatus = 'pending' | 'sent' | 'failed';

export interface ScheduledSend {
  sender_email: string;
  sender_from_name: string;
  recipient_email: string;
  recipient_name: string;
  subject: string;
  body_html: string;
  send_at_utc: Date;
  status: SendStatus;
  sent_at_utc?: Date;
  error?: string;
}

export interface PlanInput {
  manila: ManilaParts;
  senders: Array<{ email: string; from_name: string }>;
  /** Max sends per sender today (from the ramp). 0 = plan nothing. */
  dailyTarget: number;
  /** Override the recipient list — defaults to RECIPIENTS. */
  recipients?: Array<{ email: string; first_name: string }>;
  /** Override the subject bank — defaults to SUBJECTS. */
  subjects?: string[];
  /** Earliest send time. Defaults to start-of-workday (3pm Manila).
   *  Pass `new Date()` to plan only the remainder of the day after a restart. */
  earliestSendUtc?: Date;
  /** Injectable randomness for tests. Defaults to Math.random. */
  random?: () => number;
}

/** Fisher-Yates shuffle, in place, using a supplied PRNG. */
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

/**
 * Build the day's send plan.
 *
 * For each sender independently:
 *   - Shuffle the recipient list (fresh per sender → senders pick different
 *     orderings; same sender doesn't double-hit a recipient until it wraps).
 *   - Initial jitter 0..cadenceMin so the 9 senders don't all fire at 3:00pm.
 *   - Loop while: under dailyTarget AND next slot fits before workday end.
 *     Each slot: pop the next recipient in rotation, pick a random subject,
 *     advance cursor by 45-50min jitter.
 *
 * Result sorted by send_at_utc ascending so the tick can dispatch in order.
 */
export function planDay(input: PlanInput): ScheduledSend[] {
  const rand = input.random ?? Math.random;
  const recipients = input.recipients ?? RECIPIENTS;
  const subjects = input.subjects ?? SUBJECTS;

  if (
    input.senders.length === 0 ||
    recipients.length === 0 ||
    subjects.length === 0 ||
    input.dailyTarget <= 0
  ) {
    return [];
  }

  const workdayStart = manilaWallClockToUtc(input.manila, WORKDAY.startHour, 0);
  const workdayEnd = manilaWallClockToUtc(input.manila, WORKDAY.endHourExclusive, 0);

  const earliest = input.earliestSendUtc && input.earliestSendUtc > workdayStart
    ? input.earliestSendUtc
    : workdayStart;

  const sends: ScheduledSend[] = [];

  for (const sender of input.senders) {
    // Per-sender independent shuffle — recipient rotation.
    const rotation = shuffle(recipients, rand);
    let rotIdx = 0;

    // Per-sender initial jitter so the 9 senders don't all fire at 3:00pm sharp.
    const initialJitterMs = Math.floor(rand() * SENDER_CADENCE_MS.min);
    let cursor = new Date(earliest.getTime() + initialJitterMs);

    let count = 0;
    while (count < input.dailyTarget && cursor < workdayEnd) {
      const recipient = rotation[rotIdx % rotation.length];
      rotIdx++;

      const subject = pick(subjects, rand);
      const body = renderBody({
        recipient_name: recipient.first_name,
        sender_from_name: sender.from_name,
      });

      sends.push({
        sender_email: sender.email,
        sender_from_name: sender.from_name,
        recipient_email: recipient.email,
        recipient_name: recipient.first_name,
        subject,
        body_html: body,
        send_at_utc: cursor,
        status: 'pending',
      });

      count++;

      const gapMs = SENDER_CADENCE_MS.min
        + Math.floor(rand() * (SENDER_CADENCE_MS.max - SENDER_CADENCE_MS.min));
      cursor = new Date(cursor.getTime() + gapMs);
    }
  }

  sends.sort((a, b) => a.send_at_utc.getTime() - b.send_at_utc.getTime());
  return sends;
}

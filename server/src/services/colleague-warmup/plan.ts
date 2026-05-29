/**
 * Pure planner — given the day's senders, recipients, subjects, and the
 * Manila workday window, produce the full sequence of ScheduledSend rows
 * for the day. Caller decides what to do with them (execute, log, email
 * to Cathy).
 *
 * The randomization is the only impurity. Pass a `random` function for
 * deterministic tests.
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

function pick<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

/**
 * Build the day's send plan.
 *
 * For each sender independently:
 *   - Compute the start time = max(earliestSendUtc, workdayStartUtc + random initial jitter 0..cadenceMin)
 *   - Loop: pick subject + recipient at random, schedule send, advance time by 45–50 min jitter
 *   - Stop when next send would land at or after workdayEndUtc
 *
 * Result is sorted by send_at_utc ascending so the scheduler tick can dispatch in order.
 */
export function planDay(input: PlanInput): ScheduledSend[] {
  const rand = input.random ?? Math.random;
  const recipients = input.recipients ?? RECIPIENTS;
  const subjects = input.subjects ?? SUBJECTS;

  if (input.senders.length === 0 || recipients.length === 0 || subjects.length === 0) {
    return [];
  }

  const workdayStart = manilaWallClockToUtc(input.manila, WORKDAY.startHour, 0);
  const workdayEnd = manilaWallClockToUtc(input.manila, WORKDAY.endHourExclusive, 0);

  const earliest = input.earliestSendUtc && input.earliestSendUtc > workdayStart
    ? input.earliestSendUtc
    : workdayStart;

  const sends: ScheduledSend[] = [];

  for (const sender of input.senders) {
    // Per-sender initial jitter so the 9 senders don't all fire at 3:00pm sharp.
    const initialJitterMs = Math.floor(rand() * SENDER_CADENCE_MS.min);
    let cursor = new Date(earliest.getTime() + initialJitterMs);

    while (cursor < workdayEnd) {
      const recipient = pick(recipients, rand);
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

      const gapMs = SENDER_CADENCE_MS.min
        + Math.floor(rand() * (SENDER_CADENCE_MS.max - SENDER_CADENCE_MS.min));
      cursor = new Date(cursor.getTime() + gapMs);
    }
  }

  sends.sort((a, b) => a.send_at_utc.getTime() - b.send_at_utc.getTime());
  return sends;
}

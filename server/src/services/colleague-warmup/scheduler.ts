/**
 * Colleague-network warmup scheduler.
 *
 * Parallel to warmup-scheduler.ts (which cycles inside the warmup_enabled
 * pool). This one sends neutral admin-style emails from the 9 is_cold_sender
 * accounts to a fixed list of 25 internal colleagues. Humans — not the
 * system — reply and forward to build engagement signals.
 *
 * Lifecycle:
 *   - On startup (if inside the Manila Mon–Fri 3pm–10pm window), plan the
 *     remainder of the day and email Cathy ONE preview (unless we already
 *     planned today, in which case resume silently).
 *   - Every 60s, dispatch any plan rows whose send_at_utc has arrived.
 *   - When a Manila day rolls over and we re-enter the workday window, plan
 *     the full new day and send Cathy a fresh preview.
 *
 * State is in-memory only — by design, this is a ~3-week tool. A Cloud Run
 * cold-start re-plans the remainder of the day; no Cathy re-notify.
 */

import { getSupabase } from '../../lib/supabase.js';
import { sendEmail } from '../email-sender.js';
import { getAccountForUtilitySend, type SenderAccountWithCaps } from '../sender-loader.js';
import { CATHY_NOTIFICATION_EMAIL, NOTIFIER_FROM_EMAIL } from './config.js';
import { planDay, type ScheduledSend } from './plan.js';
import { dailyTargetForWorkday, getWorkdayIndex } from './ramp.js';
import { getManilaParts, isInWorkdayWindow } from './schedule-window.js';
import { sendCathyDailyPreview } from './notifier.js';

const TAG = '[ColleagueWarmup]';
const TICK_INTERVAL_MS = 60 * 1000;

// ─── In-memory state ──────────────────────────────────────────────────────────

interface DayState {
  /** YYYY-MM-DD in Manila local — used to detect day rollover. */
  dateKey: string;
  weekdayLabel: string;
  workdayIndex: number;
  dailyTarget: number;
  plan: ScheduledSend[];
  /** True once we've emailed Cathy the preview for this date. */
  cathyNotified: boolean;
}

let dayState: DayState | null = null;
let tickInFlight = false;

// ─── Guards ───────────────────────────────────────────────────────────────────
//
// Note: this scheduler intentionally does NOT honor EMAIL_SENDING_PAUSED_UNTIL.
// That kill switch pauses cold OUTREACH campaigns (campaign-scheduler.ts) after
// deliverability incidents — but the whole purpose of the colleague warmup is
// to rehabilitate sender reputation during exactly those incidents. Pausing
// both would defeat the rehab. COLLEAGUE_WARMUP_ENABLED is the dedicated kill
// switch for this loop.

function isEnabled(): boolean {
  return (process.env.COLLEAGUE_WARMUP_ENABLED ?? 'false').toLowerCase() === 'true';
}

function getStartDateKey(): string {
  return process.env.COLLEAGUE_WARMUP_START_DATE?.trim() ?? '';
}

// ─── DB: load the 9 cold-sender accounts ──────────────────────────────────────

interface ColdSenderRow {
  email: string;
  from_name: string;
}

async function loadColdSenders(): Promise<ColdSenderRow[]> {
  const { data, error } = await getSupabase()
    .from('email_accounts')
    .select('email, from_name')
    .eq('is_cold_sender', true)
    .eq('status', 'active');

  if (error) {
    console.error(`${TAG} Could not load cold senders:`, error.message);
    return [];
  }
  return ((data ?? []) as ColdSenderRow[]).filter((r) => Boolean(r.email) && Boolean(r.from_name));
}

/**
 * Resolve a cold-sender's full SenderAccountWithCaps row, including creds.
 * Cached per tick to avoid hammering the DB; cache is dropped when the tick
 * function returns.
 */
async function resolveSender(
  email: string,
  cache: Map<string, SenderAccountWithCaps | null>,
): Promise<SenderAccountWithCaps | null> {
  if (cache.has(email)) return cache.get(email)!;
  const account = await getAccountForUtilitySend(email);
  cache.set(email, account);
  return account;
}

// ─── Planning ─────────────────────────────────────────────────────────────────

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** (Re)build dayState for today, optionally restricting to remainder-of-day. */
async function buildPlanForToday(now: Date, remainderOnly: boolean): Promise<void> {
  const manila = getManilaParts(now);
  const startDateKey = getStartDateKey();
  const workdayIndex = getWorkdayIndex(startDateKey, manila.dateKey);
  const dailyTarget = dailyTargetForWorkday(workdayIndex);

  if (!startDateKey) {
    console.warn(`${TAG} COLLEAGUE_WARMUP_START_DATE is unset — nothing will be planned. Set YYYY-MM-DD (Manila local).`);
  }

  if (workdayIndex === 0) {
    console.log(
      `${TAG} ${manila.dateKey} is before start date ${startDateKey || '(unset)'} — no plan today.`,
    );
    dayState = {
      dateKey: manila.dateKey,
      weekdayLabel: WEEKDAY_LABELS[manila.weekday] ?? '?',
      workdayIndex: 0,
      dailyTarget: 0,
      plan: [],
      cathyNotified: false,
    };
    return;
  }

  const senders = await loadColdSenders();
  if (senders.length === 0) {
    console.warn(`${TAG} No active is_cold_sender accounts — nothing to plan.`);
    dayState = {
      dateKey: manila.dateKey,
      weekdayLabel: WEEKDAY_LABELS[manila.weekday] ?? '?',
      workdayIndex,
      dailyTarget,
      plan: [],
      cathyNotified: false,
    };
    return;
  }

  const plan = planDay({
    manila,
    senders: senders.map((s) => ({ email: s.email, from_name: s.from_name })),
    dailyTarget,
    earliestSendUtc: remainderOnly ? now : undefined,
  });

  dayState = {
    dateKey: manila.dateKey,
    weekdayLabel: WEEKDAY_LABELS[manila.weekday] ?? '?',
    workdayIndex,
    dailyTarget,
    plan,
    cathyNotified: false,
  };

  console.log(
    `${TAG} Planned ${plan.length} sends across ${senders.length} senders ` +
    `(workday #${workdayIndex}, target=${dailyTarget}/sender) ` +
    `for ${dayState.dateKey} (${dayState.weekdayLabel}, ${remainderOnly ? 'remainder' : 'full'})`,
  );
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatchSend(
  row: ScheduledSend,
  senderCache: Map<string, SenderAccountWithCaps | null>,
): Promise<void> {
  const senderAccount = await resolveSender(row.sender_email, senderCache);
  if (!senderAccount) {
    row.status = 'failed';
    row.error = 'sender account not found / missing creds';
    console.warn(`${TAG} Sender ${row.sender_email} unavailable — skipping send to ${row.recipient_email}`);
    return;
  }

  try {
    const result = await sendEmail(row.recipient_email, row.subject, row.body_html, {}, senderAccount);
    if (!result.success) {
      row.status = 'failed';
      row.error = result.error ?? 'unknown';
      console.warn(`${TAG} Send failed ${row.sender_email} → ${row.recipient_email}: ${row.error}`);
      return;
    }
    row.status = 'sent';
    row.sent_at_utc = new Date();
    console.log(`${TAG} Sent ${row.sender_email} → ${row.recipient_email} ("${row.subject}")`);
  } catch (err) {
    row.status = 'failed';
    row.error = err instanceof Error ? err.message : String(err);
    console.warn(`${TAG} Send threw ${row.sender_email} → ${row.recipient_email}:`, row.error);
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

export async function runColleagueWarmupTick(now: Date = new Date()): Promise<void> {
  if (tickInFlight) {
    console.log(`${TAG} Previous tick still running — skipping`);
    return;
  }
  tickInFlight = true;
  try {
    if (!isEnabled()) return;

    const manila = getManilaParts(now);
    if (!isInWorkdayWindow(manila)) return;

    // Detect day rollover OR first plan in this process. Cloud Run runs with
    // minScale=1, so a fresh dayState in memory either means start-of-Manila-day
    // or a new deploy mid-day — both warrant a fresh Cathy preview against the
    // newly-generated plan.
    const dayChanged = !dayState || dayState.dateKey !== manila.dateKey;
    if (dayChanged) {
      const isFirstPlanInProcess = !dayState;
      // remainderOnly=true whenever we're planning past workday start (which is
      // any time after 3:00pm Manila on the current day) so we don't schedule
      // sends in the past.
      await buildPlanForToday(now, isFirstPlanInProcess);

      if (dayState && !dayState.cathyNotified && dayState.plan.length > 0) {
        const ok = await sendCathyDailyPreview({
          dateKey: dayState.dateKey,
          weekdayLabel: dayState.weekdayLabel,
          plan: dayState.plan,
        });
        dayState.cathyNotified = ok;
      }
    }

    if (!dayState || dayState.plan.length === 0) return;

    const due = dayState.plan.filter(
      (r) => r.status === 'pending' && r.send_at_utc.getTime() <= now.getTime(),
    );
    if (due.length === 0) return;

    const senderCache = new Map<string, SenderAccountWithCaps | null>();
    for (const row of due) {
      if (!isEnabled()) {
        console.log(`${TAG} Disabled mid-tick — stopping dispatch.`);
        break;
      }
      await dispatchSend(row, senderCache);
    }
  } catch (err) {
    console.error(`${TAG} Tick error:`, err instanceof Error ? err.message : err);
  } finally {
    tickInFlight = false;
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

export function startColleagueWarmupScheduler(): void {
  if (!isEnabled()) {
    console.log(`${TAG} COLLEAGUE_WARMUP_ENABLED is false — scheduler not started.`);
    return;
  }
  console.log(`${TAG} Scheduler started — tick every ${TICK_INTERVAL_MS / 1000}s, target ${CATHY_NOTIFICATION_EMAIL}, from ${NOTIFIER_FROM_EMAIL}.`);

  // Initial tick on a microtask so server.listen returns immediately.
  setImmediate(() => {
    runColleagueWarmupTick().catch((err) =>
      console.error(`${TAG} Initial tick error:`, err instanceof Error ? err.message : err),
    );
  });

  setInterval(() => {
    runColleagueWarmupTick().catch((err) =>
      console.error(`${TAG} Tick error:`, err instanceof Error ? err.message : err),
    );
  }, TICK_INTERVAL_MS);
}

// ─── Test hooks (internal) ────────────────────────────────────────────────────

export function _resetStateForTest(): void {
  dayState = null;
  tickInFlight = false;
}

export function _getStateForTest(): DayState | null {
  return dayState;
}

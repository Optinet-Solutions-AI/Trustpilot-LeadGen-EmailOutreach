/**
 * How much each day already has booked, and the shared daily ceiling.
 *
 * Both numbers are needed wherever a follow-up date is chosen, so they live
 * together rather than being re-derived at each call site — three of which
 * previously just did `now + delay_days` and hoped.
 */

import { getSupabase } from '../lib/supabase.js';
import { selectAllRows } from '../lib/paginate.js';
import { loadSentCountsByDay, mergeCounts } from './sent-log.js';
import { config } from '../config.js';
import { getAccountDailyCap } from './rate-limiter.js';
import { localDayKey, BUDGET_TIMEZONE, type SendingSchedule } from './schedule-engine.js';
import type { DayLoad } from './next-step-planner.js';
import { planCampaignSendTimes, type FollowUpStep } from './campaign-send-planner.js';
import {
  projectFollowUps,
  type ForecastRow, type ForecastStep, type ProjectedFollowUp,
} from './queue-forecast.js';

export interface DayLoadOptions {
  /**
   * Ignore this campaign's own pending, already-scheduled rows.
   *
   * A campaign being (re)planned must not count its current plan against
   * itself — that is how a re-pace shunts everything a day later every time
   * it runs. Its SENT rows and its follow-ups still count, because that
   * capacity really is spent.
   */
  excludePendingForCampaign?: string;
}

/**
 * Everything already booked or sent, bucketed by local day in each owning
 * campaign's timezone — the same bucketing the calendar and re-pacer use, so
 * all three agree on what a day holds.
 */
export async function loadDayLoad(options: DayLoadOptions = {}): Promise<DayLoad> {
  const load: DayLoad = new Map();
  const supabase = getSupabase();

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, sending_schedule');
  const tz = new Map<string, string>();
  for (const c of (campaigns ?? []) as Array<Record<string, unknown>>) {
    const s = (c.sending_schedule ?? {}) as Partial<SendingSchedule>;
    tz.set(c.id as string, s.timezone || 'UTC');
  }

  // A fortnight either side is ample: nothing is scheduled further out than
  // the backlog can reach, and it keeps the read bounded.
  const lo = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const hi = new Date(Date.now() + 60 * 86_400_000).toISOString();

  // Paged: PostgREST caps a response at 1,000 rows whatever limit is asked
  // for, and a day-load computed from the first thousand is simply wrong.
  const rows = await selectAllRows<Record<string, unknown>>((from, to) => supabase
    .from('campaign_leads')
    .select('campaign_id, status, sent_at, scheduled_at, next_step_at, sequence_completed, sequence_paused')
    .eq('channel', 'email')
    .or(
      `and(sent_at.gte.${lo},sent_at.lte.${hi}),` +
      `and(scheduled_at.gte.${lo},scheduled_at.lte.${hi}),` +
      `and(next_step_at.gte.${lo},next_step_at.lte.${hi})`,
    )
    .order('id', { ascending: true })
    .range(from, to));

  // Counted on one timeline, so every campaign draws from the same 60 — see
  // BUDGET_TIMEZONE.
  const bump = (iso: string, _zone: string) => {
    const key = localDayKey(new Date(iso), BUDGET_TIMEZONE);
    load.set(key, (load.get(key) ?? 0) + 1);
  };

  // Spent budget is counted separately, below, because a row's `sent_at`
  // is rewritten by every later step and so under-reports the day the
  // earlier email actually went out.
  const spentFromRows = new Map<string, number>();
  for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
    const zone = tz.get(r.campaign_id as string) ?? 'UTC';
    if (r.status === 'sent' && r.sent_at) {
      const key = localDayKey(new Date(r.sent_at as string), BUDGET_TIMEZONE);
      spentFromRows.set(key, (spentFromRows.get(key) ?? 0) + 1);
    } else if (
      r.status === 'pending' && r.scheduled_at
      && r.campaign_id !== options.excludePendingForCampaign
    ) bump(r.scheduled_at as string, zone);
    if (r.next_step_at && r.sequence_completed === false && r.sequence_paused === false) {
      bump(r.next_step_at as string, zone);
    }
  }

  // The stricter of the row count and the append-only log — see mergeCounts.
  const spent = mergeCounts(
    spentFromRows,
    await loadSentCountsByDay(lo, hi, (at) => localDayKey(at, BUDGET_TIMEZONE)),
  );
  for (const [key, n] of spent) load.set(key, (load.get(key) ?? 0) + n);

  return load;
}

/**
 * The shared ceiling: the strictest per-account figure among live campaigns,
 * clamped by the strictest mailbox cap, times the number of cold senders.
 * Strictest rather than most generous — this decides real send volume.
 */
export async function loadCapacityPerDay(): Promise<number> {
  const supabase = getSupabase();

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('sending_schedule')
    .in('status', ['sending', 'draft']);
  const limits = (campaigns ?? [])
    .map((c: Record<string, unknown>) => ((c.sending_schedule ?? {}) as { dailyLimit?: number }).dailyLimit)
    .filter((n): n is number => typeof n === 'number' && n > 0);

  const { data: senders } = await supabase
    .from('email_accounts')
    .select('daily_cap')
    .eq('status', 'active')
    .eq('is_cold_sender', true);
  const caps = (senders ?? []).map((a: Record<string, unknown>) =>
    getAccountDailyCap({ daily_cap: (a.daily_cap as number | null | undefined) ?? null }));

  const senderCount = Math.max(1, caps.length);
  const strictestMailbox = caps.length > 0 ? Math.min(...caps) : config.rateLimits.dailyCap;
  const strictestCampaign = limits.length > 0 ? Math.min(...limits) : strictestMailbox;

  return Math.max(1, Math.min(strictestCampaign, strictestMailbox) * senderCount);
}

/**
 * One campaign's sending window, or null when it has none complete enough to
 * place within. Callers fall back to the flat delay in that case.
 */
export async function loadCampaignSchedule(campaignId: string): Promise<SendingSchedule | null> {
  const { data } = await getSupabase()
    .from('campaigns')
    .select('sending_schedule')
    .eq('id', campaignId)
    .maybeSingle();
  const raw = ((data ?? {}) as { sending_schedule?: Partial<SendingSchedule> }).sending_schedule;
  if (!raw?.timezone || !raw.startHour || !raw.endHour || !raw.days?.length) return null;
  return raw as SendingSchedule;
}

/**
 * Where one campaign's first-touch emails go, given everything else already
 * on the calendar.
 *
 * This is the difference between a plan and a wish. Campaigns used to be laid
 * out one at a time, each filling days to its own limit with no idea what the
 * others had booked, so twelve launches on one morning all claimed the same
 * days: the calendar read 99 and 102 against a real ceiling of 60, the tail of
 * the run sat empty, and the overflow aged into overdue backlog instead of
 * rolling forward. Planning against the shared load is what makes "it rolls
 * over when the cap is reached" true.
 */
export async function planCampaignQueueTimes({
  campaignId, count, schedule, senderCount, from,
}: {
  campaignId: string;
  count: number;
  schedule: SendingSchedule;
  /** Mailboxes sharing this campaign — `dailyLimit` is per account. */
  senderCount: number;
  /** Earliest moment sending may begin (start date, or now). */
  from: Date;
}): Promise<Date[]> {
  const [load, capacityPerDay, followUpSteps] = await Promise.all([
    loadDayLoad({ excludePendingForCampaign: campaignId }),
    loadCapacityPerDay(),
    loadFollowUpSteps(campaignId),
  ]);

  const ownCapacityPerDay = Math.max(
    1, schedule.dailyLimit * Math.max(1, Math.floor(senderCount)),
  );

  return planCampaignSendTimes({
    count, schedule, load, capacityPerDay, ownCapacityPerDay, followUpSteps, from,
  });
}

/**
 * One campaign's follow-up steps, so a launch can book the days its own
 * follow-ups will need at the same time as the first emails.
 */
export async function loadFollowUpSteps(campaignId: string): Promise<FollowUpStep[]> {
  const { data } = await getSupabase()
    .from('campaign_steps')
    .select('step_number, delay_days')
    .eq('campaign_id', campaignId)
    .order('step_number', { ascending: true });
  return ((data ?? []) as Array<Record<string, unknown>>).map((s) => ({
    stepNumber: s.step_number as number,
    delayDays: typeof s.delay_days === 'number' ? s.delay_days : 3,
  }));
}

/**
 * The follow-ups that exist but have no date yet, placed where they will
 * actually land.
 *
 * The horizon is fixed off `now` rather than off whatever window the caller
 * is displaying, so the calendar and the day drill-down compute the SAME
 * forecast and their numbers agree. Placing a projection depends on what the
 * rest of the calendar holds, so a different horizon would quietly give two
 * different answers for the same day.
 */
export async function loadFollowUpForecast(now: Date = new Date()): Promise<{
  projections: ProjectedFollowUp[];
  /**
   * Follow-ups behind mail that has ALREADY been sent and that carry no date.
   * These are not forecast, because nothing will ever fire them: the sequence
   * scheduler only selects rows whose next_step_at is set. They are counted
   * so the operator can be told they are stuck rather than pending.
   */
  stalled: number;
}> {
  const supabase = getSupabase();
  const lo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const hi = new Date(now.getTime() + 120 * 86_400_000).toISOString();

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, sending_schedule');

  const scheduleByCampaign = new Map<string, SendingSchedule>();
  const tz = new Map<string, string>();
  for (const c of (campaigns ?? []) as Array<Record<string, unknown>>) {
    const s = (c.sending_schedule ?? {}) as Partial<SendingSchedule>;
    tz.set(c.id as string, s.timezone || 'UTC');
    if (s.timezone && s.startHour && s.endHour && s.days?.length && s.dailyLimit) {
      scheduleByCampaign.set(c.id as string, s as SendingSchedule);
    }
  }

  const { data: stepRows } = await supabase
    .from('campaign_steps')
    .select('campaign_id, step_number, delay_days')
    .order('step_number', { ascending: true });

  const stepsByCampaign = new Map<string, ForecastStep[]>();
  for (const s of (stepRows ?? []) as Array<Record<string, unknown>>) {
    const list = stepsByCampaign.get(s.campaign_id as string) ?? [];
    list.push({
      stepNumber: s.step_number as number,
      delayDays: typeof s.delay_days === 'number' ? s.delay_days : 3,
    });
    stepsByCampaign.set(s.campaign_id as string, list);
  }

  const rows = await selectAllRows<Record<string, unknown>>((from, to) => supabase
    .from('campaign_leads')
    .select('id, campaign_id, status, sent_at, scheduled_at, next_step_at, current_step, sequence_completed, sequence_paused')
    .eq('channel', 'email')
    .or(
      `and(sent_at.gte.${lo},sent_at.lte.${hi}),` +
      `and(scheduled_at.gte.${lo},scheduled_at.lte.${hi}),` +
      `and(next_step_at.gte.${lo},next_step_at.lte.${hi})`,
    )
    .order('id', { ascending: true })
    .range(from, to));

  // What the days already hold, by the same rules loadDayLoad uses — a
  // projection has to queue behind real mail, not on top of it.
  const load: DayLoad = new Map();
  const bump = (iso: string, _zone: string) => {
    const key = localDayKey(new Date(iso), BUDGET_TIMEZONE);
    load.set(key, (load.get(key) ?? 0) + 1);
  };

  const forecastRows: ForecastRow[] = [];
  const spentFromRows = new Map<string, number>();
  let stalled = 0;

  for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
    const campaignId = r.campaign_id as string;
    const zone = tz.get(campaignId) ?? 'UTC';

    if (r.status === 'sent' && r.sent_at) {
      const key = localDayKey(new Date(r.sent_at as string), BUDGET_TIMEZONE);
      spentFromRows.set(key, (spentFromRows.get(key) ?? 0) + 1);
    } else if (r.status === 'pending' && r.scheduled_at) bump(r.scheduled_at as string, zone);
    if (r.next_step_at && r.sequence_completed === false && r.sequence_paused === false) {
      bump(r.next_step_at as string, zone);
    }

    if (r.sequence_completed !== false || r.sequence_paused !== false) continue;
    if (r.next_step_at) continue; // already has a date, already visible
    const steps = stepsByCampaign.get(campaignId) ?? [];
    if (steps.length === 0) continue;

    const currentStep = typeof r.current_step === 'number' ? r.current_step : 0;

    if (r.status === 'pending' && r.scheduled_at) {
      // The first touch is still ahead of us, so every configured step is too.
      forecastRows.push({
        campaignId,
        campaignLeadId: r.id as string,
        baseAt: new Date(r.scheduled_at as string),
        currentStep: 0,
      });
    } else if ((r.status === 'sent' || r.status === 'opened') && r.sent_at) {
      stalled += steps.filter((s) => s.stepNumber > Math.max(currentStep, 1)).length;
    }
  }

  // Same rule as loadDayLoad: the stricter of the row count and the log.
  const spent = mergeCounts(
    spentFromRows,
    await loadSentCountsByDay(lo, hi, (at) => localDayKey(at, BUDGET_TIMEZONE)),
  );
  for (const [key, n] of spent) load.set(key, (load.get(key) ?? 0) + n);

  const capacityPerDay = await loadCapacityPerDay();
  const projections = projectFollowUps({
    rows: forecastRows, stepsByCampaign, scheduleByCampaign, load, capacityPerDay, now,
  });

  return { projections, stalled };
}

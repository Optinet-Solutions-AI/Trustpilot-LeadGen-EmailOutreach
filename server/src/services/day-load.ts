/**
 * How much each day already has booked, and the shared daily ceiling.
 *
 * Both numbers are needed wherever a follow-up date is chosen, so they live
 * together rather than being re-derived at each call site — three of which
 * previously just did `now + delay_days` and hoped.
 */

import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { getAccountDailyCap } from './rate-limiter.js';
import { localDayKey, type SendingSchedule } from './schedule-engine.js';
import type { DayLoad } from './next-step-planner.js';

/**
 * Everything already booked or sent, bucketed by local day in each owning
 * campaign's timezone — the same bucketing the calendar and re-pacer use, so
 * all three agree on what a day holds.
 */
export async function loadDayLoad(): Promise<DayLoad> {
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

  const { data: rows } = await supabase
    .from('campaign_leads')
    .select('campaign_id, status, sent_at, scheduled_at, next_step_at, sequence_completed, sequence_paused')
    .eq('channel', 'email')
    .or(
      `and(sent_at.gte.${lo},sent_at.lte.${hi}),` +
      `and(scheduled_at.gte.${lo},scheduled_at.lte.${hi}),` +
      `and(next_step_at.gte.${lo},next_step_at.lte.${hi})`,
    )
    .limit(20000);

  const bump = (iso: string, zone: string) => {
    const key = localDayKey(new Date(iso), zone);
    load.set(key, (load.get(key) ?? 0) + 1);
  };

  for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
    const zone = tz.get(r.campaign_id as string) ?? 'UTC';
    if (r.status === 'sent' && r.sent_at) bump(r.sent_at as string, zone);
    else if (r.status === 'pending' && r.scheduled_at) bump(r.scheduled_at as string, zone);
    if (r.next_step_at && r.sequence_completed === false && r.sequence_paused === false) {
      bump(r.next_step_at as string, zone);
    }
  }

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

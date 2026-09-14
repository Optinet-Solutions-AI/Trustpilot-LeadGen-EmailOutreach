/**
 * What the send queue will actually look like — without writing anything.
 *
 * Runs the real re-pacer and the real follow-up forecast over live data, then
 * prints the per-day shape, the finish date, and the gap each lead will see
 * between its first email and its follow-up. The gap is the number worth
 * watching: when 60/day is the ceiling and the queue holds 1,200 emails, first
 * touches can crowd out follow-ups and push a "just following up on last
 * week's note" a fortnight past the note.
 *
 * Read-only by default. Pass --apply to write the re-paced dates back; the
 * forecast rows are never written, because a follow-up's real date is chosen
 * by the scheduler when the email before it actually sends.
 *
 *   npx tsx src/tools/queue-dryrun.ts
 *   npx tsx src/tools/queue-dryrun.ts --apply
 */

import { getSupabase } from '../lib/supabase.js';
import { selectAllRows } from '../lib/paginate.js';
import { config } from '../config.js';
import { getAccountDailyCap } from '../services/rate-limiter.js';
import { repaceQueue } from '../services/queue-repacer.js';
import { projectFollowUps, type ForecastRow, type ForecastStep } from '../services/queue-forecast.js';
import { localDayKey, BUDGET_TIMEZONE, type SendingSchedule } from '../services/schedule-engine.js';
import type { DayLoad } from '../services/next-step-planner.js';

interface CampaignMeta {
  name: string;
  status: string;
  schedule: SendingSchedule | null;
  tz: string;
  dailyLimit?: number;
}

async function main() {
  const supabase = getSupabase();
  const now = new Date();
  const apply = process.argv.includes('--apply');

  const { data: campaigns } = await supabase
    .from('campaigns').select('id, name, status, sending_schedule');

  const meta = new Map<string, CampaignMeta>();
  for (const c of (campaigns ?? []) as Array<Record<string, unknown>>) {
    const raw = (c.sending_schedule ?? {}) as Partial<SendingSchedule>;
    const complete = Boolean(raw.timezone && raw.startHour && raw.endHour && raw.days?.length);
    meta.set(c.id as string, {
      name: (c.name as string) ?? 'Untitled',
      status: c.status as string,
      schedule: complete ? (raw as SendingSchedule) : null,
      tz: raw.timezone || 'UTC',
      dailyLimit: typeof raw.dailyLimit === 'number' && raw.dailyLimit > 0 ? raw.dailyLimit : undefined,
    });
  }

  const { data: stepRows } = await supabase
    .from('campaign_steps').select('campaign_id, step_number, delay_days').order('step_number');
  const stepsByCampaign = new Map<string, ForecastStep[]>();
  for (const s of (stepRows ?? []) as Array<Record<string, unknown>>) {
    const list = stepsByCampaign.get(s.campaign_id as string) ?? [];
    list.push({ stepNumber: s.step_number as number, delayDays: (s.delay_days as number) ?? 3 });
    stepsByCampaign.set(s.campaign_id as string, list);
  }

  const live = await selectAllRows<Record<string, unknown>>((from, to) => supabase
    .from('campaign_leads')
    .select('id, campaign_id, status, sent_at, scheduled_at, next_step_at, current_step, sequence_completed, sequence_paused')
    .eq('channel', 'email')
    .order('id', { ascending: true })
    .range(from, to));
  const campaignOf = new Map<string, string>();
  for (const r of live) campaignOf.set(r.id as string, r.campaign_id as string);

  const { data: senders } = await supabase
    .from('email_accounts').select('email, daily_cap')
    .eq('status', 'active').eq('is_cold_sender', true);
  const caps = (senders ?? []).map((a: Record<string, unknown>) =>
    getAccountDailyCap({ daily_cap: (a.daily_cap as number | null | undefined) ?? null }));
  const senderCount = Math.max(1, caps.length);
  const strictestAccount = caps.length > 0 ? Math.min(...caps) : config.rateLimits.dailyCap;

  const limits = [...new Set(live
    .filter((r) => (r.status === 'pending' && r.scheduled_at) || r.next_step_at)
    .map((r) => r.campaign_id as string))]
    .map((id) => meta.get(id)?.dailyLimit)
    .filter((n): n is number => typeof n === 'number');
  const perAccount = Math.min(limits.length ? Math.min(...limits) : strictestAccount, strictestAccount);
  const capacityPerDay = perAccount * senderCount;

  console.log(`mailboxes: ${senderCount} | per mailbox: ${perAccount} | CAPACITY/DAY: ${capacityPerDay}\n`);

  // ── what has already gone out (spent budget) ─────────────────────────────
  const alreadySent: Record<string, number> = {};
  const twoDaysAgo = now.getTime() - 2 * 86_400_000;
  for (const r of live) {
    if (r.status !== 'sent' || !r.sent_at) continue;
    const m = meta.get(r.campaign_id as string);
    if (!m) continue;
    const at = new Date(r.sent_at as string);
    if (at.getTime() < twoDaysAgo) continue;
    const key = localDayKey(at, BUDGET_TIMEZONE);
    alreadySent[key] = (alreadySent[key] ?? 0) + 1;
  }

  // ── re-pace everything that already carries a date ───────────────────────
  const items = [];
  for (const r of live) {
    const m = meta.get(r.campaign_id as string);
    if (!m?.schedule) continue;
    if (r.status === 'pending' && r.scheduled_at) {
      items.push({
        id: `${r.id}:first_touch`, kind: 'first_touch' as const,
        at: new Date(r.scheduled_at as string), schedule: m.schedule,
        // Books the day this prospect's follow-up will need, so first touches
        // cannot take every slot and strand it at the end of the run.
        followUpSteps: stepsByCampaign.get(r.campaign_id as string),
      });
    }
    if (r.next_step_at && r.sequence_completed === false && r.sequence_paused === false) {
      items.push({
        id: `${r.id}:follow_up`, kind: 'follow_up' as const,
        at: new Date(r.next_step_at as string), schedule: m.schedule,
      });
    }
  }
  const plan = repaceQueue(items, { capacityPerDay, alreadySent, from: now });
  const moved = plan.filter((p) => p.to.getTime() !== p.from.getTime()).length;
  console.log(`re-paced rows: ${plan.length} (moved: ${moved})`);

  // ── the load AFTER the re-pace, then forecast the dateless follow-ups ────
  const load: DayLoad = new Map();
  for (const [k, n] of Object.entries(alreadySent)) load.set(k, n);
  const firstTouchAt = new Map<string, Date>();
  for (const p of plan) {
    const [id, kind] = p.id.split(':');
    const key = localDayKey(p.to, BUDGET_TIMEZONE);
    load.set(key, (load.get(key) ?? 0) + 1);
    if (kind === 'first_touch') firstTouchAt.set(id, p.to);
  }

  const scheduleByCampaign = new Map<string, SendingSchedule>();
  for (const [id, m] of meta) if (m.schedule) scheduleByCampaign.set(id, m.schedule);

  const forecastRows: ForecastRow[] = [];
  for (const r of live) {
    if (r.sequence_completed !== false || r.sequence_paused !== false) continue;
    if (r.next_step_at) continue;
    if ((stepsByCampaign.get(r.campaign_id as string) ?? []).length === 0) continue;
    if (r.status === 'pending' && r.scheduled_at) {
      forecastRows.push({
        campaignId: r.campaign_id as string,
        campaignLeadId: r.id as string,
        baseAt: firstTouchAt.get(r.id as string) ?? new Date(r.scheduled_at as string),
        currentStep: 0,
      });
    }
  }
  const projections = projectFollowUps({
    rows: forecastRows, stepsByCampaign, scheduleByCampaign, load, capacityPerDay, now,
  });
  console.log(`forecast follow-ups: ${projections.length}`);

  // ── the shape ────────────────────────────────────────────────────────────
  const perDay = new Map<string, { first: number; follow: number }>();
  const bump = (key: string, k: 'first' | 'follow') => {
    const d = perDay.get(key) ?? { first: 0, follow: 0 };
    d[k] += 1;
    perDay.set(key, d);
  };
  for (const p of plan) {
    const [id, kind] = p.id.split(':');
    bump(localDayKey(p.to, BUDGET_TIMEZONE), kind === 'follow_up' ? 'follow' : 'first');
  }
  for (const proj of projections) {
    bump(localDayKey(proj.at, BUDGET_TIMEZONE), 'follow');
  }

  const days = [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log('\ndate          new   f/u  total   sent   cap');
  let total = 0;
  for (const [date, d] of days) {
    const t = d.first + d.follow;
    total += t;
    const sentToday = alreadySent[date] ?? 0;
    const over = t + sentToday > capacityPerDay ? '  <-- OVER' : '';
    console.log(
      `${date}   ${String(d.first).padStart(4)}  ${String(d.follow).padStart(4)} ${String(t).padStart(6)}` +
      `  ${String(sentToday).padStart(5)}  ${capacityPerDay}${over}`,
    );
  }
  console.log(`\nTOTAL still to send: ${total} across ${days.length} days | last day ${days[days.length - 1]?.[0]}`);

  // Same work, bucketed in ONE timezone. Per-campaign days overlap when the
  // campaigns sit in different zones, so a shared 60/day can read as 63 on a
  // single calendar without anything actually over-sending.
  const utcDay = new Map<string, number>();
  for (const p2 of plan) {
    const k = localDayKey(p2.to, 'UTC');
    utcDay.set(k, (utcDay.get(k) ?? 0) + 1);
  }
  for (const proj of projections) {
    const k = localDayKey(proj.at, 'UTC');
    utcDay.set(k, (utcDay.get(k) ?? 0) + 1);
  }
  const utcOver = [...utcDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .filter(([k, v]) => v + (alreadySent[k] ?? 0) > capacityPerDay);
  console.log(`\nbucketed in UTC only — days over ${capacityPerDay}: ${utcOver.length}`);
  for (const [k, v] of utcOver) console.log('   ' + k + '  ' + (v + (alreadySent[k] ?? 0)));

  // ── the gap each lead sees between email 1 and email 2 ───────────────────
  const gaps: number[] = [];
  for (const proj of projections) {
    if (proj.stepNumber !== 2) continue;
    const firstAt = firstTouchAt.get(proj.campaignLeadId);
    if (firstAt) gaps.push(Math.round((proj.at.getTime() - firstAt.getTime()) / 86_400_000));
  }
  gaps.sort((a, b) => a - b);
  if (gaps.length > 0) {
    const at = (q: number) => gaps[Math.floor((gaps.length - 1) * q)];
    console.log(
      `\nfirst email -> follow-up gap (days): min ${gaps[0]} | median ${at(0.5)}` +
      ` | 90th ${at(0.9)} | max ${gaps[gaps.length - 1]}`,
    );
    const buckets = new Map<number, number>();
    for (const g of gaps) buckets.set(g, (buckets.get(g) ?? 0) + 1);
    console.log('   ' + [...buckets.entries()].sort((a, b) => a[0] - b[0])
      .map(([g, n]) => `${g}d x${n}`).join('   '));
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit these dates.');
    return;
  }

  // Batched and parallel: a serial loop over ~700 rows runs long enough that a
  // gateway times out mid-write and leaves the queue half-paced.
  const movedRows = plan.filter((q) => q.to.getTime() !== q.from.getTime());
  let written = 0;
  let failed = 0;
  const BATCH = 25;
  for (let i = 0; i < movedRows.length; i += BATCH) {
    const slice = movedRows.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(async (q) => {
      const [id, kind] = q.id.split(':');
      const patch = kind === 'follow_up'
        ? { next_step_at: q.to.toISOString() }
        : { scheduled_at: q.to.toISOString() };
      const base = supabase.from('campaign_leads').update(patch).eq('id', id);
      // A first touch is only re-dated while it is still pending — never
      // restamp mail that left while this was running.
      const { error } = kind === 'follow_up' ? await base : await base.eq('status', 'pending');
      return !error;
    }));
    written += results.filter(Boolean).length;
    failed += results.filter((ok) => !ok).length;
  }
  console.log(
    '\nAPPLIED — rewrote ' + written + ' of ' + movedRows.length + ' dates'
    + (failed ? ' (' + failed + ' failed)' : ''),
  );
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * What happens if we hold the follow-up to its 3-day promise?
 *
 * Every campaign is configured with delay_days = 3, but the delay is a
 * SOONEST, not a guarantee: a follow-up lands on the first day that still has
 * room. With 600 first emails queued ahead of them and a hard 60/day ceiling,
 * the first touches fill every day for a fortnight and the follow-ups queue
 * behind them — measured 2026-09-14, a median gap of 10 days against a
 * configured 3.
 *
 * The fix is not a bigger number anywhere; the total volume fixes the finish
 * date. It is to stop first touches taking the whole day, so there is room
 * three days later for the follow-up each one creates. This models that:
 * first touches are capped at `--reserve` per day and follow-ups take the
 * rest of the shared 60.
 *
 *   npx tsx src/tools/queue-what-if.ts --reserve 30
 *
 * --priority models the better answer: rather than capping first emails at a
 * fixed number, each prospect's whole sequence is placed at once, so the
 * follow-up claims its day the moment the first email claims its own. First
 * emails then fill whatever is left. Follow-ups are never crowded out, and no
 * capacity is wasted early while waiting for them to appear.
 *
 *   npx tsx src/tools/queue-what-if.ts --priority
 *
 * Read-only. Nothing is written, ever.
 */

import { getSupabase } from '../lib/supabase.js';
import { selectAllRows } from '../lib/paginate.js';
import { config } from '../config.js';
import { getAccountDailyCap } from '../services/rate-limiter.js';
import { planNextStepAt, type DayLoad } from '../services/next-step-planner.js';
import { localDayKey, BUDGET_TIMEZONE, type SendingSchedule } from '../services/schedule-engine.js';

const DAY_MS = 86_400_000;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function main() {
  const supabase = getSupabase();
  const now = new Date();
  const reserve = arg('reserve', 30);
  const priority = process.argv.includes('--priority');

  const { data: campaigns } = await supabase
    .from('campaigns').select('id, name, sending_schedule');
  const schedules = new Map<string, SendingSchedule>();
  for (const c of (campaigns ?? []) as Array<Record<string, unknown>>) {
    const raw = (c.sending_schedule ?? {}) as Partial<SendingSchedule>;
    if (raw.timezone && raw.startHour && raw.endHour && raw.days?.length && raw.dailyLimit) {
      schedules.set(c.id as string, raw as SendingSchedule);
    }
  }

  const { data: stepRows } = await supabase
    .from('campaign_steps').select('campaign_id, step_number, delay_days').order('step_number');
  const steps = new Map<string, Array<{ stepNumber: number; delayDays: number }>>();
  for (const s of (stepRows ?? []) as Array<Record<string, unknown>>) {
    const list = steps.get(s.campaign_id as string) ?? [];
    list.push({ stepNumber: s.step_number as number, delayDays: (s.delay_days as number) ?? 3 });
    steps.set(s.campaign_id as string, list);
  }

  const live = await selectAllRows<Record<string, unknown>>((from, to) => supabase
    .from('campaign_leads')
    .select('id, campaign_id, status, sent_at, scheduled_at, next_step_at, current_step, sequence_completed, sequence_paused')
    .eq('channel', 'email').order('id', { ascending: true }).range(from, to));

  const { data: senders } = await supabase
    .from('email_accounts').select('daily_cap').eq('status', 'active').eq('is_cold_sender', true);
  const caps = (senders ?? []).map((a: Record<string, unknown>) =>
    getAccountDailyCap({ daily_cap: (a.daily_cap as number | null | undefined) ?? null }));
  const senderCount = Math.max(1, caps.length);
  const capacityPerDay = (caps.length ? Math.min(...caps) : config.rateLimits.dailyCap) * senderCount;

  console.log(priority
    ? `capacity ${capacityPerDay}/day · follow-ups booked with their first email, so they win the day\n`
    : `capacity ${capacityPerDay}/day · first emails capped at ${reserve}/day` +
      ` · ${capacityPerDay - reserve}/day left for follow-ups\n`);

  // Spent budget first — today is partly gone.
  const load: DayLoad = new Map();
  const twoDaysAgo = now.getTime() - 2 * DAY_MS;
  for (const r of live) {
    if (r.status !== 'sent' || !r.sent_at) continue;
    const at = new Date(r.sent_at as string);
    if (at.getTime() < twoDaysAgo) continue;
    const key = localDayKey(at, BUDGET_TIMEZONE);
    load.set(key, (load.get(key) ?? 0) + 1);
  }

  const perDay = new Map<string, { first: number; follow: number }>();
  const bump = (at: Date, kind: 'first' | 'follow') => {
    const key = localDayKey(at, BUDGET_TIMEZONE);
    const d = perDay.get(key) ?? { first: 0, follow: 0 };
    d[kind] += 1;
    perDay.set(key, d);
  };

  // 1. Follow-ups that already carry a date were promised first — they keep
  //    priority over anything new.
  const dated = live
    .filter((r) => r.next_step_at && r.sequence_completed === false && r.sequence_paused === false)
    .sort((a, b) => String(a.next_step_at).localeCompare(String(b.next_step_at)));
  for (const r of dated) {
    const schedule = schedules.get(r.campaign_id as string);
    if (!schedule) continue;
    const at = planNextStepAt({
      load, schedule, capacityPerDay, now,
      earliest: new Date(Math.max(new Date(r.next_step_at as string).getTime(), now.getTime())),
    });
    bump(at, 'follow');
  }

  // 2. First touches, in the order they are queued now.
  const firstLoad: DayLoad = new Map();
  const firstTouchAt = new Map<string, Date>();
  const gaps: number[] = [];
  const pending = live
    .filter((r) => r.status === 'pending' && r.scheduled_at)
    .sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));

  for (const r of pending) {
    const schedule = schedules.get(r.campaign_id as string);
    if (!schedule) continue;
    const earliest = new Date(Math.max(new Date(r.scheduled_at as string).getTime(), now.getTime()));

    const firstAt = priority
      // Nothing caps first emails directly; they simply cannot take a slot a
      // follow-up has already claimed, because each prospect's follow-up is
      // booked at the same moment as its first email (below).
      ? planNextStepAt({ load, schedule, capacityPerDay, now, earliest })
      : planNextStepAt({
        load, schedule, capacityPerDay, now, earliest,
        ownLoad: firstLoad, ownCapacityPerDay: reserve,
      });
    firstTouchAt.set(r.id as string, firstAt);
    bump(firstAt, 'first');

    if (!priority) continue;
    // 3a. PRIORITY MODE: book the rest of this prospect's sequence now, while
    //     the days after it are still empty. The follow-up therefore lands on
    //     its promised day, and the first emails that come after have to work
    //     around it instead of the other way round.
    const plan = [...(steps.get(r.campaign_id as string) ?? [])].sort((a, b) => a.stepNumber - b.stepNumber);
    if (r.sequence_completed !== false || r.sequence_paused !== false) continue;
    let cursor = firstAt;
    for (const step of plan) {
      const at = planNextStepAt({
        load, schedule, capacityPerDay, now,
        earliest: new Date(Math.max(cursor.getTime() + step.delayDays * DAY_MS, now.getTime())),
      });
      bump(at, 'follow');
      if (step.stepNumber === 2) gaps.push(Math.round((at.getTime() - firstAt.getTime()) / DAY_MS));
      cursor = at;
    }
  }

  if (!priority) {
    // 3b. RESERVE MODE: every first email is placed before any follow-up is
    //     considered, which is what pushes the follow-ups to the back.
    for (const r of pending) {
      const schedule = schedules.get(r.campaign_id as string);
      const plan = [...(steps.get(r.campaign_id as string) ?? [])].sort((a, b) => a.stepNumber - b.stepNumber);
      if (!schedule || plan.length === 0) continue;
      if (r.sequence_completed !== false || r.sequence_paused !== false) continue;
      const firstAt = firstTouchAt.get(r.id as string);
      if (!firstAt) continue;
      let cursor = firstAt;
      for (const step of plan) {
        const at = planNextStepAt({
          load, schedule, capacityPerDay, now,
          earliest: new Date(Math.max(cursor.getTime() + step.delayDays * DAY_MS, now.getTime())),
        });
        bump(at, 'follow');
        if (step.stepNumber === 2) gaps.push(Math.round((at.getTime() - firstAt.getTime()) / DAY_MS));
        cursor = at;
      }
    }
  }

  const days = [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log('date          new   f/u  total   cap');
  let total = 0;
  for (const [date, d] of days) {
    const t = d.first + d.follow;
    total += t;
    const sent = date === localDayKey(now, BUDGET_TIMEZONE) ? (load.get(date) ?? 0) : 0;
    console.log(
      `${date}   ${String(d.first).padStart(4)}  ${String(d.follow).padStart(4)}` +
      ` ${String(t).padStart(6)}  ${capacityPerDay}` +
      (t > capacityPerDay ? '  <-- OVER' : ''),
    );
    void sent;
  }
  console.log(`\nTOTAL ${total} emails · ${days.length} days · last day ${days[days.length - 1]?.[0]}`);

  gaps.sort((a, b) => a - b);
  if (gaps.length > 0) {
    const at = (q: number) => gaps[Math.floor((gaps.length - 1) * q)];
    console.log(
      `\nfirst email -> follow-up gap: min ${gaps[0]} · median ${at(0.5)}` +
      ` · 90th ${at(0.9)} · max ${gaps[gaps.length - 1]} days`,
    );
    const buckets = new Map<number, number>();
    for (const g of gaps) buckets.set(g, (buckets.get(g) ?? 0) + 1);
    console.log('   ' + [...buckets.entries()].sort((a, b) => a[0] - b[0])
      .map(([g, n]) => `${g}d x${n}`).join('   '));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

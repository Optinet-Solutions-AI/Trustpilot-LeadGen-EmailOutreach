'use client';

import { useMemo, useState } from 'react';
import { useQueueCalendar, isoDate, type QueueDay } from '../hooks/useQueueCalendar';
import Card from '../ui/Card';
import LoadingState from '../ui/LoadingState';
import SectionHeader from '../ui/SectionHeader';

/**
 * Send queue as a month calendar.
 *
 * Exists because nothing in the app showed a per-day forecast, which is how
 * 5 September 2026 sent 43 emails against a cap of 30 without warning: the
 * 21 follow-ups in that total appeared in no view at all. Follow-ups are
 * therefore a first-class number here, not a footnote.
 */

function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function QueueCalendar() {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  const from = isoDate(startOfMonth(cursor));
  const to   = isoDate(endOfMonth(cursor));
  const { data, loading, error } = useQueueCalendar(from, to);
  const [openDay, setOpenDay] = useState<string | null>(null);

  const byDate = useMemo(() => {
    const m = new Map<string, QueueDay>();
    for (const d of data?.days ?? []) m.set(d.date, d);
    return m;
  }, [data]);

  /** Leading blanks so the 1st sits under its weekday (Monday-first). */
  const cells = useMemo(() => {
    const first = startOfMonth(cursor);
    const last = endOfMonth(cursor);
    const lead = (first.getDay() + 6) % 7; // 0 = Monday
    const out: Array<{ date: string; day: number } | null> = Array.from({ length: lead }, () => null);
    for (let n = 1; n <= last.getDate(); n++) {
      out.push({ date: isoDate(new Date(cursor.getFullYear(), cursor.getMonth(), n)), day: n });
    }
    return out;
  }, [cursor]);

  const monthLabel = cursor.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  const today = isoDate(new Date());
  const selected = openDay ? byDate.get(openDay) ?? null : null;

  const shift = (months: number) =>
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + months, 1));

  return (
    <div className="p-4 lg:p-8 space-y-6">
      <SectionHeader
        title="Send Queue"
        subtitle="What goes out each day — first emails and follow-ups together, in each campaign's own timezone."
      />

      {/* Totals for the month in view */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'First emails', value: data?.totals.firstTouch ?? 0, icon: 'outgoing_mail', tone: 'text-on-surface' },
          { label: 'Follow-ups',   value: data?.totals.followUp ?? 0,   icon: 'reply',         tone: 'text-on-surface' },
          { label: 'Total',        value: data?.totals.total ?? 0,      icon: 'functions',     tone: 'text-on-surface' },
          { label: 'Days over cap', value: data?.totals.daysOver ?? 0,  icon: 'warning',
            tone: (data?.totals.daysOver ?? 0) > 0 ? 'text-[#ba1a1a]' : 'text-on-surface' },
        ].map((s) => (
          <Card key={s.label}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-wider text-on-surface-variant font-bold">{s.label}</p>
                <p className={`text-3xl font-extrabold mt-1 tabular-nums ${s.tone}`}>{s.value}</p>
              </div>
              <span className="material-symbols-outlined text-on-surface-variant opacity-40">{s.icon}</span>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        {/* Month navigation */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => shift(-1)}
              aria-label="Previous month"
              className="w-9 h-9 rounded-full hover:bg-surface-variant flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b0004a]"
            >
              <span className="material-symbols-outlined">chevron_left</span>
            </button>
            <h3 className="font-bold text-lg text-on-surface min-w-[10rem] text-center">{monthLabel}</h3>
            <button
              onClick={() => shift(1)}
              aria-label="Next month"
              className="w-9 h-9 rounded-full hover:bg-surface-variant flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b0004a]"
            >
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
            <button
              onClick={() => setCursor(startOfMonth(new Date()))}
              className="ml-1 text-sm font-bold text-[#b0004a] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b0004a] rounded px-1"
            >
              This month
            </button>
          </div>

          {/* Legend — the two numbers in every cell */}
          <div className="flex items-center gap-4 text-xs text-on-surface-variant">
            <span className="flex items-center gap-1.5">
              <i className="w-2.5 h-2.5 rounded-sm bg-[#b0004a] inline-block" /> first email
            </span>
            <span className="flex items-center gap-1.5">
              <i className="w-2.5 h-2.5 rounded-sm bg-[#006630] inline-block" /> follow-up
            </span>
            <span className="flex items-center gap-1.5">
              <i className="w-2.5 h-2.5 rounded-sm bg-[#ba1a1a] inline-block" /> over cap
            </span>
            {data && <span>{data.senderCount} mailbox{data.senderCount === 1 ? '' : 'es'}</span>}
          </div>
        </div>

        {error && (
          <p className="text-sm text-[#ba1a1a] mb-4">
            {error} — the queue could not be loaded, so this month shows nothing rather than zeros.
          </p>
        )}
        {loading && !data && <LoadingState />}

        {/* Month grid */}
        <div className="overflow-x-auto">
          <div className="min-w-[44rem]">
            <div className="grid grid-cols-7 gap-1.5 mb-1.5">
              {WEEKDAYS.map((w) => (
                <div key={w} className="text-[0.68rem] font-bold uppercase tracking-wider text-on-surface-variant text-center py-1">
                  {w}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1.5">
              {cells.map((cell, i) => {
                if (!cell) return <div key={`blank-${i}`} className="min-h-[5.5rem]" />;
                const d = byDate.get(cell.date);
                const isToday = cell.date === today;
                const over = d?.overCapacity ?? false;

                return (
                  <button
                    key={cell.date}
                    onClick={() => d && setOpenDay(openDay === cell.date ? null : cell.date)}
                    aria-label={
                      d
                        ? `${cell.date}: ${d.firstTouch} first emails, ${d.followUp} follow-ups, ${d.total} total`
                        : `${cell.date}: nothing scheduled`
                    }
                    className={[
                      'min-h-[5.5rem] p-2 text-left rounded-lg border transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b0004a]',
                      over
                        ? 'border-[#ba1a1a] bg-[#ba1a1a]/[0.06]'
                        : d
                          ? 'border-outline-variant hover:bg-surface-variant'
                          : 'border-transparent bg-surface-variant/30',
                      openDay === cell.date ? 'ring-2 ring-[#b0004a]' : '',
                      d ? 'cursor-pointer' : 'cursor-default',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-between">
                      <span className={[
                        'text-xs font-bold tabular-nums',
                        isToday ? 'bg-[#b0004a] text-white rounded-full w-5 h-5 flex items-center justify-center' : 'text-on-surface-variant',
                      ].join(' ')}>
                        {cell.day}
                      </span>
                      {over && (
                        <span className="material-symbols-outlined text-[#ba1a1a] text-[16px]" title={`${d!.overBy} over the cap`}>
                          warning
                        </span>
                      )}
                    </div>

                    {d ? (
                      <div className="mt-1.5 space-y-0.5">
                        <p className={`text-xl font-extrabold leading-none tabular-nums ${over ? 'text-[#ba1a1a]' : 'text-on-surface'}`}>
                          {d.total}
                        </p>
                        <p className="text-[0.68rem] leading-tight text-on-surface-variant tabular-nums">
                          {d.firstTouch > 0 && <span className="text-[#b0004a] font-bold">{d.firstTouch} new</span>}
                          {d.firstTouch > 0 && d.followUp > 0 && ' · '}
                          {d.followUp > 0 && <span className="text-[#006630] font-bold">{d.followUp} f/u</span>}
                        </p>
                        {d.capacity !== null && (
                          <p className="text-[0.62rem] text-on-surface-variant tabular-nums">
                            {over ? `+${d.overBy} over ${d.capacity}` : `cap ${d.capacity}`}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="mt-2 text-[0.68rem] text-on-surface-variant opacity-50">—</p>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </Card>

      {/* Selected day detail */}
      {selected && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h3 className="font-bold text-lg text-on-surface">
              {new Date(`${selected.date}T12:00:00Z`).toLocaleDateString('en-GB', {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
              })}
            </h3>
            <button
              onClick={() => setOpenDay(null)}
              className="text-sm font-bold text-on-surface-variant hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b0004a] rounded px-1"
            >
              Close
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
            {[
              ['First emails', selected.firstTouch],
              ['Follow-ups', selected.followUp],
              ['Already sent', selected.sent],
              ['Still queued', selected.scheduled],
            ].map(([label, value]) => (
              <div key={label as string}>
                <p className="text-[0.68rem] uppercase tracking-wider font-bold text-on-surface-variant">{label}</p>
                <p className="text-2xl font-extrabold text-on-surface tabular-nums">{value}</p>
              </div>
            ))}
          </div>

          {selected.overCapacity && (
            <p className="text-sm mb-4 px-3 py-2 rounded-lg bg-[#ba1a1a]/[0.08] text-[#ba1a1a] font-medium">
              {selected.overBy} over the {selected.capacity} a day these mailboxes allow. Sends past
              the cap are held back and roll into later days, so this day will spread out.
            </p>
          )}

          <p className="text-[0.68rem] uppercase tracking-wider font-bold text-on-surface-variant mb-2">
            Campaigns on this day
          </p>
          <ul className="divide-y divide-outline-variant">
            {selected.campaigns.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2 gap-4">
                <span className="text-sm text-on-surface truncate">{c.name}</span>
                <span className="text-sm font-bold text-on-surface tabular-nums shrink-0">{c.count}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

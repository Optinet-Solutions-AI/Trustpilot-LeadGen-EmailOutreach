'use client';

import { useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { useDailyAnalytics, type DailyAnalyticsDay } from '../hooks/useDailyAnalytics';

// Format YYYY-MM-DD as today's UTC date string. Used for default range + presets.
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return toIsoDate(d);
}

function firstOfMonth(offset: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return toIsoDate(d);
}

function lastOfMonth(offset: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset + 1);
  d.setUTCDate(0);
  return toIsoDate(d);
}

type Preset = '7d' | '30d' | 'this-month' | 'last-month' | 'custom';

const PRESETS: { label: string; value: Preset }[] = [
  { label: 'Last 7 Days', value: '7d' },
  { label: 'Last 30 Days', value: '30d' },
  { label: 'This Month', value: 'this-month' },
  { label: 'Last Month', value: 'last-month' },
  { label: 'Custom', value: 'custom' },
];

function rangeForPreset(preset: Preset, currentStart: string, currentEnd: string): { start: string; end: string } {
  switch (preset) {
    case '7d':         return { start: daysAgo(6),       end: daysAgo(0) };
    case '30d':        return { start: daysAgo(29),      end: daysAgo(0) };
    case 'this-month': return { start: firstOfMonth(0),  end: daysAgo(0) };
    case 'last-month': return { start: firstOfMonth(-1), end: lastOfMonth(-1) };
    case 'custom':     return { start: currentStart,     end: currentEnd };
  }
}

// Short axis label, e.g. "May 11"
function formatTick(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function DailyActivityChart() {
  const [preset, setPreset] = useState<Preset>('30d');
  const [start, setStart] = useState<string>(daysAgo(29));
  const [end, setEnd] = useState<string>(daysAgo(0));

  const { data, loading, error } = useDailyAnalytics(start, end);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') {
      const r = rangeForPreset(p, start, end);
      setStart(r.start);
      setEnd(r.end);
    }
  };

  const chartData: DailyAnalyticsDay[] = useMemo(() => data?.days ?? [], [data]);

  return (
    <div className="bg-surface-container-lowest rounded-xl p-6 sm:p-8 ambient-shadow">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-6">
        <div>
          <h3
            className="font-bold text-lg text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Daily Activity
          </h3>
          <p className="text-secondary text-xs mt-0.5">
            Sent and replied per day (UTC). Pick a range for reporting.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1 p-1 bg-surface-container-low rounded-lg">
          {PRESETS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => applyPreset(value)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${
                preset === value ? 'bg-white shadow-sm text-[#b0004a]' : 'text-secondary hover:bg-white/50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap items-center gap-3 mb-4 text-xs">
          <label className="flex items-center gap-2 font-medium text-secondary">
            From
            <input
              type="date"
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
              className="px-2 py-1 rounded-md border border-surface-container bg-white text-on-surface"
            />
          </label>
          <label className="flex items-center gap-2 font-medium text-secondary">
            To
            <input
              type="date"
              value={end}
              min={start}
              max={toIsoDate(new Date())}
              onChange={(e) => setEnd(e.target.value)}
              className="px-2 py-1 rounded-md border border-surface-container bg-white text-on-surface"
            />
          </label>
        </div>
      )}

      <div className="flex gap-6 mb-4 text-xs font-medium">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-[#b0004a] inline-block" />
          Sent <span className="text-secondary">({data?.totals.sent.toLocaleString() ?? '—'})</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-[#006630] inline-block" />
          Replied <span className="text-secondary">({data?.totals.replied.toLocaleString() ?? '—'})</span>
        </span>
      </div>

      {loading ? (
        <div className="h-[260px] flex items-center justify-center text-secondary text-sm gap-2">
          <span className="material-symbols-outlined animate-spin">progress_activity</span>
          Loading daily activity…
        </div>
      ) : error ? (
        <div className="h-[260px] flex items-center justify-center text-error text-sm">{error}</div>
      ) : chartData.length === 0 ? (
        <div className="h-[260px] flex items-center justify-center text-secondary text-sm">
          No activity in this range.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="#eee" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: '#5f5e5e' }}
              tickFormatter={formatTick}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#5f5e5e' }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{ background: '#fff', border: 'none', borderRadius: '0.5rem', boxShadow: '0 4px 24px rgba(25,28,29,.08)' }}
              labelFormatter={(d) => formatTick(String(d))}
              labelStyle={{ fontWeight: 700, fontSize: 12 }}
            />
            <Legend wrapperStyle={{ display: 'none' }} />
            <Line type="monotone" dataKey="sent"    name="Sent"    stroke="#b0004a" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 5 }} />
            <Line type="monotone" dataKey="replied" name="Replied" stroke="#006630" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 5 }} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

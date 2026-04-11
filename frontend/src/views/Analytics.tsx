'use client';

import { useEffect, useState } from 'react';
import { useAnalytics, type AnalyticsPeriod } from '../hooks/useAnalytics';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';

const STATUS_COLORS: Record<string, string> = {
  new: '#c8c6c6',
  contacted: '#b0004a',
  replied: '#006630',
  converted: '#d81b60',
  lost: '#ba1a1a',
};

const PERIOD_OPTIONS: { label: string; value: AnalyticsPeriod }[] = [
  { label: '7 Days', value: '7d' },
  { label: '30 Days', value: '30d' },
  { label: 'All Time', value: 'all' },
];

export default function Analytics() {
  const { data, loading, fetchAnalytics } = useAnalytics();
  const [period, setPeriod] = useState<AnalyticsPeriod>('all');

  useEffect(() => { fetchAnalytics(period); }, [fetchAnalytics, period]);

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-secondary">
          <span className="material-symbols-outlined animate-spin">progress_activity</span>
          Loading analytics...
        </div>
      </div>
    );
  }

  const totalSent    = data.campaigns.reduce((s, c) => s + c.total_sent, 0);
  const totalOpened  = data.campaigns.reduce((s, c) => s + c.total_opened, 0);
  const totalReplied = data.campaigns.reduce((s, c) => s + c.total_replied, 0);
  const totalBounced = data.campaigns.reduce((s, c) => s + c.total_bounced, 0);
  const openRate     = totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : '0.0';
  const replyRate    = totalSent > 0 ? ((totalReplied / totalSent) * 100).toFixed(1) : '0.0';

  const statusData = Object.entries(data.leadsByStatus)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }));

  const countryData = Object.entries(data.leadsByCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, value]) => ({ name, value }));

  const campaignData = data.campaigns.map((c) => ({
    name: c.name.length > 18 ? c.name.slice(0, 18) + '…' : c.name,
    Sent: c.total_sent,
    Replied: c.total_replied,
    Bounced: c.total_bounced,
  }));

  const metricCards = [
    { label: 'Total Emails Sent', value: totalSent.toLocaleString(), icon: 'send',        accent: 'border-[#b0004a]',  big: true },
    { label: 'Open Rate',         value: `${openRate}%`,             icon: 'drafts',       accent: 'border-pink-300',   big: false },
    { label: 'Reply Rate',        value: `${replyRate}%`,            icon: 'reply',        accent: 'border-tertiary',   big: false },
    { label: 'Bounced',           value: totalBounced.toLocaleString(), icon: 'bounce',    accent: 'border-error',      big: false },
  ];

  return (
    <div className="px-10 py-10 space-y-8">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2
            className="text-4xl font-extrabold tracking-tight text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Analytics &amp; <span className="text-[#b0004a]">Performance</span>
          </h2>
          <p className="text-secondary mt-1 font-medium">Visualizing campaign vitality and engagement metrics.</p>
        </div>
        <div className="flex items-center gap-1 p-1 bg-surface-container-low rounded-lg">
          {PERIOD_OPTIONS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setPeriod(value)}
              className={`px-4 py-2 rounded-md text-xs font-bold transition-all ${
                period === value ? 'bg-white shadow-sm text-[#b0004a]' : 'text-secondary hover:bg-white/50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Metrics Bento */}
      <div className="grid grid-cols-4 gap-5">
        {metricCards.map(({ label, value, icon, accent, big }) => (
          <div
            key={label}
            className={`bg-surface-container-lowest rounded-xl p-6 ambient-shadow border-l-4 ${accent} relative overflow-hidden`}
          >
            <div className="flex justify-between items-start mb-4">
              <span className="p-2 bg-primary-fixed text-[#b0004a] rounded-lg material-symbols-outlined text-[20px]">
                {icon}
              </span>
            </div>
            <p className="text-secondary text-xs font-bold uppercase tracking-widest mb-1">{label}</p>
            <p
              className={`font-black text-on-surface ${big ? 'text-4xl' : 'text-3xl'}`}
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              {value}
            </p>
            {big && (
              <div className="absolute -right-4 -bottom-4 opacity-5">
                <span className="material-symbols-outlined text-[120px]">{icon}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-3 gap-6">
        {/* Performance Timeline (bar chart) */}
        <div className="col-span-2 bg-surface-container-lowest rounded-xl p-8 ambient-shadow">
          <div className="flex justify-between items-center mb-6">
            <h3
              className="font-bold text-lg text-on-surface"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              Campaign Performance
            </h3>
            <div className="flex gap-4 text-xs font-medium">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-[#b0004a] inline-block" /> Sent</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-[#006630] inline-block" /> Replied</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-[#ba1a1a] inline-block" /> Bounced</span>
            </div>
          </div>
          {campaignData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={campaignData} barGap={4}>
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#5f5e5e' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#5f5e5e' }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: '#fff', border: 'none', borderRadius: '0.5rem', boxShadow: '0 4px 24px rgba(25,28,29,.08)' }}
                  labelStyle={{ fontWeight: 700, fontSize: 12 }}
                />
                <Bar dataKey="Sent"    fill="#b0004a" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Replied" fill="#006630" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Bounced" fill="#ba1a1a" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-secondary text-sm">
              No campaign data yet
            </div>
          )}
        </div>

        {/* Delivery Health */}
        <div className="bg-surface-container-lowest rounded-xl p-8 ambient-shadow flex flex-col">
          <h3
            className="font-bold text-lg text-on-surface mb-6"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Delivery Health
          </h3>
          <div className="flex-1 flex flex-col justify-center gap-6">
            {[
              { label: 'Inbox Placement', pct: totalSent > 0 ? Math.max(0, 100 - (totalBounced / totalSent * 100)).toFixed(1) : '100.0', color: 'bg-tertiary', textColor: 'text-tertiary' },
              { label: 'Open Rate',       pct: openRate,  color: 'bg-[#b0004a]',   textColor: 'text-[#b0004a]' },
              { label: 'Reply Rate',      pct: replyRate, color: 'bg-secondary',   textColor: 'text-secondary' },
              { label: 'Bounce Rate',     pct: totalSent > 0 ? (totalBounced / totalSent * 100).toFixed(1) : '0.0', color: 'bg-error', textColor: 'text-error' },
            ].map(({ label, pct, color, textColor }) => (
              <div key={label}>
                <div className="flex justify-between mb-1.5">
                  <span className="text-sm font-medium text-on-surface">{label}</span>
                  <span className={`text-sm font-bold ${textColor}`}>{pct}%</span>
                </div>
                <div className="h-1.5 w-full bg-surface-container rounded-full overflow-hidden">
                  <div
                    className={`h-full ${color} rounded-full`}
                    style={{ width: `${Math.min(100, parseFloat(pct as string))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-8 p-4 bg-slate-50 rounded-lg">
            <p className="text-xs text-secondary leading-relaxed">
              <span className="font-bold text-[#b0004a]">Insight: </span>
              {parseFloat(replyRate) > 5
                ? 'Great reply rate! Consider scaling your sending volume.'
                : 'Optimize your subject lines to improve open and reply rates.'}
            </p>
          </div>
        </div>
      </div>

      {/* Lead Status + Country */}
      <div className="grid grid-cols-2 gap-6">
        {/* Leads by Status */}
        <div className="bg-surface-container-lowest rounded-xl p-8 ambient-shadow">
          <h3
            className="font-bold text-lg text-on-surface mb-6"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Leads by Status
          </h3>
          {statusData.some((d) => d.value > 0) ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={statusData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%" cy="50%"
                  outerRadius={80}
                  label={({ name, value }) => `${name}: ${value}`}
                  labelLine={false}
                >
                  {statusData.map((entry) => (
                    <Cell key={entry.name} fill={STATUS_COLORS[entry.name] || '#c8c6c6'} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: '#fff', border: 'none', borderRadius: '0.5rem', boxShadow: '0 4px 24px rgba(25,28,29,.08)' }} />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  formatter={(value) => <span style={{ fontSize: 12, color: '#5f5e5e', fontWeight: 600 }}>{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-secondary text-sm">No data yet</div>
          )}
        </div>

        {/* Leads by Country */}
        <div className="bg-surface-container-lowest rounded-xl p-8 ambient-shadow">
          <h3
            className="font-bold text-lg text-on-surface mb-6"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Leads by Country
          </h3>
          {countryData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={countryData} layout="vertical" barSize={14}>
                <XAxis type="number" tick={{ fontSize: 11, fill: '#5f5e5e' }} axisLine={false} tickLine={false} />
                <YAxis
                  type="category" dataKey="name"
                  tick={{ fontSize: 11, fill: '#5f5e5e' }} axisLine={false} tickLine={false}
                  width={80}
                />
                <Tooltip contentStyle={{ background: '#fff', border: 'none', borderRadius: '0.5rem', boxShadow: '0 4px 24px rgba(25,28,29,.08)' }} />
                <Bar dataKey="value" fill="#b0004a" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-secondary text-sm">No data yet</div>
          )}
        </div>
      </div>

      {/* Campaign Breakdown Table */}
      {data.campaigns.length > 0 && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
          <div className="p-8 border-b border-surface-container-low flex justify-between items-center">
            <div>
              <h3
                className="font-bold text-xl text-on-surface"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                Campaign Breakdown
              </h3>
              <p className="text-sm text-secondary mt-0.5">Performance split by active campaign flows.</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-surface-container-low">
                  <th className="px-8 py-4 text-[10px] font-black uppercase tracking-widest text-secondary">Campaign Name</th>
                  <th className="px-8 py-4 text-[10px] font-black uppercase tracking-widest text-secondary">Sent</th>
                  <th className="px-8 py-4 text-[10px] font-black uppercase tracking-widest text-secondary">Open Rate</th>
                  <th className="px-8 py-4 text-[10px] font-black uppercase tracking-widest text-secondary">Reply Rate</th>
                  <th className="px-8 py-4 text-[10px] font-black uppercase tracking-widest text-secondary">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-container-low">
                {data.campaigns.map((c) => {
                  const or = c.total_sent > 0 ? ((c.total_opened / c.total_sent) * 100).toFixed(1) : '0.0';
                  const rr = c.total_sent > 0 ? ((c.total_replied / c.total_sent) * 100).toFixed(1) : '0.0';
                  return (
                    <tr key={c.id} className="hover:bg-surface-container/30 transition-colors">
                      <td className="px-8 py-5 font-bold text-sm text-on-surface">{c.name}</td>
                      <td className="px-8 py-5 font-medium text-sm">{c.total_sent}</td>
                      <td className="px-8 py-5 font-bold text-sm text-[#b0004a]">{or}%</td>
                      <td className="px-8 py-5 font-medium text-sm">{rr}%</td>
                      <td className="px-8 py-5">
                        <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${
                          c.status === 'sending' || c.status === 'sent'
                            ? 'bg-[#8ff9a8]/30 text-[#006630]'
                            : c.status === 'draft'
                              ? 'bg-surface-container-highest text-secondary'
                              : 'bg-surface-container text-secondary'
                        }`}>
                          {c.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

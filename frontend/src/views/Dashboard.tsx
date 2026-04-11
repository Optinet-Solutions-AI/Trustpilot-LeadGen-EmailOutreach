'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAnalytics } from '../hooks/useAnalytics';
import { useFollowUps } from '../hooks/useFollowUps';

export default function Dashboard() {
  const { data, loading, error, fetchAnalytics } = useAnalytics();
  const { followUps, fetchFollowUps } = useFollowUps();
  const router = useRouter();

  useEffect(() => { fetchAnalytics(); fetchFollowUps(); }, [fetchAnalytics, fetchFollowUps]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-secondary">
          <span className="material-symbols-outlined animate-spin">progress_activity</span>
          Loading dashboard...
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="px-10 py-12">
        <div className="bg-surface-container-lowest rounded-xl p-10 ambient-shadow text-center max-w-lg mx-auto">
          <span className="material-symbols-outlined text-4xl text-error mb-4 block">error_outline</span>
          <p className="font-bold text-on-surface mb-2">{error || 'Could not load dashboard data.'}</p>
          <p className="text-sm text-secondary mb-6">
            Make sure the API is reachable and{' '}
            <code className="bg-surface-container px-1.5 py-0.5 rounded text-xs">NEXT_PUBLIC_API_BASE_URL</code>{' '}
            is set in Vercel.
          </p>
          <button
            onClick={fetchAnalytics}
            className="px-6 py-2.5 primary-gradient text-on-primary rounded-lg font-bold text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const totalSent = data.campaigns.reduce((s, c) => s + c.total_sent, 0);
  const totalReplied = data.campaigns.reduce((s, c) => s + c.total_replied, 0);
  const replyRate = totalSent > 0 ? ((totalReplied / totalSent) * 100).toFixed(1) : '0.0';

  const statCards = [
    { label: 'Total Leads',  value: data.totalLeads,                  icon: 'group',       trend: null },
    { label: 'New',          value: data.leadsByStatus.new || 0,       icon: 'fiber_new',   trend: null },
    { label: 'Contacted',    value: data.leadsByStatus.contacted || 0, icon: 'send',        trend: null },
    { label: 'Replied',      value: data.leadsByStatus.replied || 0,   icon: 'reply',       trend: null },
    { label: 'Converted',    value: data.leadsByStatus.converted || 0, icon: 'check_circle',trend: null },
    { label: 'Reply Rate',   value: `${replyRate}%`,                   icon: 'trending_up', trend: null },
  ];

  return (
    <div className="px-10 py-10 space-y-8">
      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h2
            className="text-4xl font-extrabold tracking-tight text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Dashboard <span className="text-[#b0004a]">Overview</span>
          </h2>
          <p className="text-secondary mt-1 font-medium">Your outreach pipeline at a glance.</p>
        </div>
        <button
          onClick={() => router.push('/scrape')}
          className="flex items-center gap-2 px-5 py-2.5 primary-gradient text-on-primary rounded-lg font-bold text-sm ambient-shadow hover:scale-[1.02] transition-transform"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          <span className="material-symbols-outlined text-[18px]">search_check</span>
          New Scrape
        </button>
      </div>

      {/* Stats Bento */}
      <div className="grid grid-cols-3 gap-5">
        {statCards.map(({ label, value, icon }) => (
          <div key={label} className="bg-surface-container-lowest p-6 rounded-xl ambient-shadow">
            <div className="flex items-center justify-between mb-4">
              <span className="p-2 bg-[#ffd9de] text-[#b0004a] rounded-lg material-symbols-outlined text-[20px]">
                {icon}
              </span>
            </div>
            <p className="text-slate-500 text-xs font-bold uppercase tracking-wider">{label}</p>
            <h4
              className="text-2xl font-black text-on-surface mt-1"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              {typeof value === 'number' ? value.toLocaleString() : value}
            </h4>
          </div>
        ))}
      </div>

      {/* Lower Grid */}
      <div className="grid grid-cols-2 gap-6">
        {/* Upcoming Follow-ups */}
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
          <div className="px-7 py-5 border-b border-slate-50 flex items-center gap-3">
            <span className="material-symbols-outlined text-[#b0004a]">schedule</span>
            <h3
              className="font-bold text-on-surface"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              Upcoming Follow-ups
            </h3>
          </div>
          <div className="divide-y divide-slate-50">
            {followUps.slice(0, 5).map((fu) => {
              const isOverdue = new Date(fu.due_date) < new Date();
              return (
                <div
                  key={fu.id}
                  className="flex items-center justify-between px-7 py-4 hover:bg-surface-container transition-colors cursor-pointer"
                  onClick={() => router.push(`/leads/${fu.lead_id}`)}
                >
                  <div>
                    <p className="text-sm font-bold text-on-surface">{fu.leads?.company_name || 'Unknown'}</p>
                    <p className="text-xs text-secondary mt-0.5">{fu.note}</p>
                  </div>
                  <span className={`text-xs font-bold ${isOverdue ? 'text-error' : 'text-secondary'} flex items-center gap-1`}>
                    {isOverdue && <span className="material-symbols-outlined text-[14px]">warning</span>}
                    {new Date(fu.due_date).toLocaleDateString()}
                  </span>
                </div>
              );
            })}
            {followUps.length === 0 && (
              <p className="text-sm text-secondary text-center py-10">No upcoming follow-ups</p>
            )}
          </div>
        </div>

        {/* Recent Scrapes */}
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
          <div className="px-7 py-5 border-b border-slate-50 flex items-center gap-3">
            <span className="material-symbols-outlined text-[#b0004a]">search_check</span>
            <h3
              className="font-bold text-on-surface"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              Recent Scrapes
            </h3>
          </div>
          <div className="divide-y divide-slate-50">
            {data.recentScrapeJobs.map((job) => (
              <div key={job.id} className="flex items-center justify-between px-7 py-4">
                <div>
                  <p className="text-sm font-bold text-on-surface">{job.category} — {job.country}</p>
                  <p className="text-xs text-secondary mt-0.5">{new Date(job.created_at).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-bold text-on-surface">{job.total_found} found</span>
                  {job.status === 'completed' && (
                    <span className="px-2 py-0.5 bg-[#8ff9a8]/30 text-[#006630] text-[10px] font-black rounded-full uppercase">
                      Done
                    </span>
                  )}
                  {job.status === 'running' && (
                    <span className="px-2 py-0.5 bg-[#ffd9de] text-[#b0004a] text-[10px] font-black rounded-full uppercase">
                      Running
                    </span>
                  )}
                </div>
              </div>
            ))}
            {data.recentScrapeJobs.length === 0 && (
              <p className="text-sm text-secondary text-center py-10">No scrape jobs yet</p>
            )}
          </div>
        </div>
      </div>

      {/* Campaign Performance */}
      {data.campaigns.length > 0 && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
          <div className="px-7 py-5 border-b border-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-[#b0004a]">campaign</span>
              <h3
                className="font-bold text-on-surface"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                Campaign Performance
              </h3>
            </div>
            <button
              onClick={() => router.push('/campaigns')}
              className="text-xs font-bold text-[#b0004a] hover:underline flex items-center gap-1"
            >
              View All
              <span className="material-symbols-outlined text-[14px]">chevron_right</span>
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-slate-50/50">
                  <th className="px-7 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400">Campaign</th>
                  <th className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400 text-right">Sent</th>
                  <th className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400 text-right">Opened</th>
                  <th className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400 text-right">Replied</th>
                  <th className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400 text-right">Bounced</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {data.campaigns.map((c) => (
                  <tr key={c.id} className="hover:bg-surface-container/40 transition-colors">
                    <td className="px-7 py-4 font-bold text-sm text-on-surface">{c.name}</td>
                    <td className="px-6 py-4 text-right text-sm font-medium">{c.total_sent}</td>
                    <td className="px-6 py-4 text-right text-sm font-bold text-[#b0004a]">{c.total_opened}</td>
                    <td className="px-6 py-4 text-right text-sm font-bold text-[#006630]">{c.total_replied}</td>
                    <td className="px-6 py-4 text-right text-sm font-bold text-error">{c.total_bounced}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

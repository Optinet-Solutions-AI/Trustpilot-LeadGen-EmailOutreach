'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAnalytics } from '../hooks/useAnalytics';
import { useFollowUps } from '../hooks/useFollowUps';
import Button from '../ui/Button';
import Card from '../ui/Card';
import EmptyState from '../ui/EmptyState';
import LoadingState from '../ui/LoadingState';
import Pill from '../ui/Pill';
import SectionHeader from '../ui/SectionHeader';
import Stat from '../ui/Stat';

export default function Dashboard() {
  const { data, loading, error, fetchAnalytics } = useAnalytics();
  const { followUps, fetchFollowUps } = useFollowUps();
  const router = useRouter();

  useEffect(() => { fetchAnalytics(); fetchFollowUps(); }, [fetchAnalytics, fetchFollowUps]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingState label="Loading dashboard…" />
      </div>
    );
  }

  if (error || !data) {
    const isNetworkError = !!error && error.startsWith('Network Error');
    return (
      <div className="px-4 py-8 sm:px-10 sm:py-12">
        <div className="max-w-lg mx-auto">
          <Card>
            <EmptyState
              icon="error_outline"
              title={error || 'Could not load dashboard data.'}
              description={
                isNetworkError ? (
                  <>
                    If this keeps happening, confirm{' '}
                    <code className="bg-surface-container px-1.5 py-0.5 rounded text-xs">
                      NEXT_PUBLIC_API_BASE_URL
                    </code>{' '}
                    is set in Vercel.
                  </>
                ) : undefined
              }
              action={
                <Button onClick={() => { fetchAnalytics(); fetchFollowUps(); }}>Retry</Button>
              }
            />
          </Card>
        </div>
      </div>
    );
  }

  const totalSent = data.campaigns.reduce((s, c) => s + c.total_sent, 0);
  const totalReplied = data.campaigns.reduce((s, c) => s + c.total_replied, 0);
  const replyRate = totalSent > 0 ? ((totalReplied / totalSent) * 100).toFixed(1) : '0.0';

  const statCards: { label: string; value: number | string; icon: string }[] = [
    { label: 'Total Leads',  value: data.totalLeads,                   icon: 'group' },
    { label: 'New',          value: data.leadsByStatus.new || 0,       icon: 'fiber_new' },
    { label: 'Contacted',    value: data.leadsByStatus.contacted || 0, icon: 'send' },
    { label: 'Replied',      value: data.leadsByStatus.replied || 0,   icon: 'reply' },
    { label: 'Converted',    value: data.leadsByStatus.converted || 0, icon: 'check_circle' },
    { label: 'Reply Rate',   value: `${replyRate}%`,                   icon: 'trending_up' },
  ];

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-8 xl:px-10 xl:py-10 space-y-4 sm:space-y-8">
      <SectionHeader
        title="Dashboard"
        accent="Overview"
        subtitle="Your outreach pipeline at a glance."
        actions={
          <Button
            onClick={() => router.push('/scrape')}
            leadingIcon={<span className="material-symbols-outlined text-[18px]">search_check</span>}
          >
            New Scrape
          </Button>
        }
      />

      {/* Stats Bento */}
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4 xl:gap-5">
        {statCards.map(({ label, value, icon }) => (
          <Stat
            key={label}
            icon={icon}
            label={label}
            value={typeof value === 'number' ? value.toLocaleString() : value}
          />
        ))}
      </div>

      {/* Lower Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        {/* Upcoming Follow-ups */}
        <Card
          variant="flush"
          header={
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-[#b0004a]">schedule</span>
              <h3
                className="font-bold text-on-surface"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                Upcoming Follow-ups
              </h3>
            </div>
          }
        >
          <div className="divide-y divide-slate-50">
            {followUps.slice(0, 5).map((fu) => {
              const isOverdue = new Date(fu.due_date) < new Date();
              return (
                <div
                  key={fu.id}
                  className="flex items-center justify-between px-4 sm:px-7 py-4 hover:bg-surface-container transition-colors cursor-pointer"
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
        </Card>

        {/* Recent Scrapes */}
        <Card
          variant="flush"
          header={
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-[#b0004a]">search_check</span>
              <h3
                className="font-bold text-on-surface"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                Recent Scrapes
              </h3>
            </div>
          }
        >
          <div className="divide-y divide-slate-50">
            {data.recentScrapeJobs.map((job) => (
              <div key={job.id} className="flex items-center justify-between px-7 py-4">
                <div>
                  <p className="text-sm font-bold text-on-surface">{job.category} — {job.country}</p>
                  <p className="text-xs text-secondary mt-0.5">{new Date(job.created_at).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-bold text-on-surface">{job.total_found} found</span>
                  {job.status === 'completed' && <Pill variant="success" size="sm">Done</Pill>}
                  {job.status === 'running' && <Pill variant="running" size="sm">Running</Pill>}
                  {job.status === 'failed' && <Pill variant="error" size="sm">Failed</Pill>}
                </div>
              </div>
            ))}
            {data.recentScrapeJobs.length === 0 && (
              <p className="text-sm text-secondary text-center py-10">No scrape jobs yet</p>
            )}
          </div>
        </Card>
      </div>

      {/* Campaign Performance */}
      {data.campaigns.length > 0 && (
        <Card
          variant="flush"
          header={
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-[#b0004a]">campaign</span>
              <h3
                className="font-bold text-on-surface"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                Campaign Performance
              </h3>
            </div>
          }
          actions={
            <button
              onClick={() => router.push('/campaigns')}
              className="text-xs font-bold text-[#b0004a] hover:underline flex items-center gap-1"
            >
              View All
              <span className="material-symbols-outlined text-[14px]">chevron_right</span>
            </button>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-slate-50/50">
                  <th className="px-7 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400">Campaign</th>
                  <th className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400 text-right">Sent</th>
                  <th className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400 text-right">Replied</th>
                  <th className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400 text-right">Bounced</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {data.campaigns.map((c) => (
                  <tr key={c.id} className="hover:bg-surface-container/40 transition-colors">
                    <td className="px-7 py-4 font-bold text-sm text-on-surface">{c.name}</td>
                    <td className="px-6 py-4 text-right text-sm font-medium">{c.total_sent}</td>
                    <td className="px-6 py-4 text-right text-sm font-bold text-[#006630]">{c.total_replied}</td>
                    <td className="px-6 py-4 text-right text-sm font-bold text-error">{c.total_bounced}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAnalytics } from '../hooks/useAnalytics';
import { useFollowUps } from '../hooks/useFollowUps';
import StatsRow from '../components/StatsRow';
import { Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';

export default function Dashboard() {
  const { data, loading, error, fetchAnalytics } = useAnalytics();
  const { followUps, fetchFollowUps } = useFollowUps();
  const router = useRouter();

  useEffect(() => { fetchAnalytics(); fetchFollowUps(); }, [fetchAnalytics, fetchFollowUps]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">Loading dashboard...</div>;
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-red-500 font-medium">
          {error || 'Could not load dashboard data.'}
        </p>
        <p className="text-sm text-gray-500">
          Make sure the API server is reachable. Check that{' '}
          <code className="bg-gray-100 px-1 rounded">NEXT_PUBLIC_API_BASE_URL</code> is set correctly in your Vercel environment variables.
        </p>
        <button
          onClick={fetchAnalytics}
          className="px-4 py-2 text-sm bg-gray-900 text-white rounded hover:bg-gray-700"
        >
          Retry
        </button>
      </div>
    );
  }

  const stats = [
    { label: 'Total Leads', value: data.totalLeads, color: 'text-gray-900' },
    { label: 'New', value: data.leadsByStatus.new || 0, color: 'text-gray-600' },
    { label: 'Contacted', value: data.leadsByStatus.contacted || 0, color: 'text-blue-600' },
    { label: 'Replied', value: data.leadsByStatus.replied || 0, color: 'text-green-600' },
    { label: 'Converted', value: data.leadsByStatus.converted || 0, color: 'text-purple-600' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <StatsRow stats={stats} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upcoming Follow-ups */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <Clock size={16} /> Upcoming Follow-ups
          </h2>
          <div className="space-y-2">
            {followUps.slice(0, 5).map((fu) => {
              const isOverdue = new Date(fu.due_date) < new Date();
              return (
                <div key={fu.id} className="flex items-center justify-between p-2 rounded hover:bg-gray-50 cursor-pointer"
                  onClick={() => router.push(`/leads/${fu.lead_id}`)}>
                  <div>
                    <p className="text-sm font-medium">{fu.leads?.company_name || 'Unknown'}</p>
                    <p className="text-xs text-gray-500">{fu.note}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    {isOverdue && <AlertTriangle size={12} className="text-red-500" />}
                    <span className={`text-xs ${isOverdue ? 'text-red-500 font-medium' : 'text-gray-400'}`}>
                      {new Date(fu.due_date).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              );
            })}
            {followUps.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">No upcoming follow-ups</p>
            )}
          </div>
        </div>

        {/* Recent Scrape Jobs */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3">Recent Scrapes</h2>
          <div className="space-y-2">
            {data.recentScrapeJobs.map((job) => (
              <div key={job.id} className="flex items-center justify-between p-2">
                <div>
                  <p className="text-sm font-medium">{job.category} - {job.country}</p>
                  <p className="text-xs text-gray-500">{new Date(job.created_at).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{job.total_found} found</span>
                  {job.status === 'completed' && <CheckCircle2 size={14} className="text-green-500" />}
                </div>
              </div>
            ))}
            {data.recentScrapeJobs.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">No scrape jobs yet</p>
            )}
          </div>
        </div>

        {/* Campaign Summary */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 lg:col-span-2">
          <h2 className="font-semibold mb-3">Campaign Performance</h2>
          {data.campaigns.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2">Campaign</th>
                    <th className="text-right py-2">Sent</th>
                    <th className="text-right py-2">Opened</th>
                    <th className="text-right py-2">Replied</th>
                    <th className="text-right py-2">Bounced</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((c) => (
                    <tr key={c.id} className="border-b">
                      <td className="py-2">{c.name}</td>
                      <td className="text-right py-2">{c.total_sent}</td>
                      <td className="text-right py-2">{c.total_opened}</td>
                      <td className="text-right py-2 text-green-600">{c.total_replied}</td>
                      <td className="text-right py-2 text-red-600">{c.total_bounced}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-400 text-center py-4">No campaigns yet</p>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import { useAnalytics } from '../hooks/useAnalytics';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import StatsRow from '../components/StatsRow';

const STATUS_COLORS: Record<string, string> = {
  new: '#9ca3af', contacted: '#3b82f6', replied: '#22c55e', converted: '#a855f7', lost: '#ef4444',
};

export default function Analytics() {
  const { data, loading, fetchAnalytics } = useAnalytics();

  useEffect(() => { fetchAnalytics(); }, [fetchAnalytics]);

  if (loading || !data) {
    return <div className="flex items-center justify-center h-64 text-gray-400">Loading analytics...</div>;
  }

  // Prepare chart data
  const statusData = Object.entries(data.leadsByStatus).map(([name, value]) => ({
    name, value,
  }));

  const countryData = Object.entries(data.leadsByCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, value]) => ({ name, value }));

  const campaignData = data.campaigns.map((c) => ({
    name: c.name.length > 15 ? c.name.slice(0, 15) + '...' : c.name,
    Sent: c.total_sent,
    Replied: c.total_replied,
    Bounced: c.total_bounced,
  }));

  const stats = [
    { label: 'Total Leads', value: data.totalLeads },
    { label: 'Campaigns', value: data.campaigns.length },
    { label: 'Total Sent', value: data.campaigns.reduce((s, c) => s + c.total_sent, 0) },
    { label: 'Total Replied', value: data.campaigns.reduce((s, c) => s + c.total_replied, 0), color: 'text-green-600' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Analytics</h1>
      <StatsRow stats={stats} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Leads by Status Pie */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3">Leads by Status</h2>
          {statusData.some((d) => d.value > 0) ? (
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%"
                  outerRadius={80} label={({ name, value }) => `${name}: ${value}`}>
                  {statusData.map((entry) => (
                    <Cell key={entry.name} fill={STATUS_COLORS[entry.name] || '#9ca3af'} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-gray-400 text-center py-12">No data yet</p>
          )}
        </div>

        {/* Leads by Country Bar */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3">Leads by Country</h2>
          {countryData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={countryData}>
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="value" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-gray-400 text-center py-12">No data yet</p>
          )}
        </div>

        {/* Campaign Performance */}
        {campaignData.length > 0 && (
          <div className="bg-white rounded-lg border border-gray-200 p-5 lg:col-span-2">
            <h2 className="font-semibold mb-3">Campaign Performance</h2>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={campaignData}>
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="Sent" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Replied" fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Bounced" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}

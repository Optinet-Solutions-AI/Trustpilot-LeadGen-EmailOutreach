'use client';

import { useEffect, useState } from 'react';
import { X, Loader2, Mail, CheckCircle, AlertCircle, Clock, MessageSquare } from 'lucide-react';
import type { Campaign } from '../types/campaign';

interface CampaignLead {
  id: string;
  lead_id: string;
  email_used: string | null;
  status: string;
  sent_at: string | null;
  leads: { company_name: string; star_rating: number; country: string; category: string } | null;
}

interface Props {
  campaign: Campaign;
  onClose: () => void;
  fetchLeads: (id: string) => Promise<CampaignLead[]>;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  pending: { label: 'Pending',  color: 'bg-gray-100 text-gray-600',   icon: <Clock size={11} /> },
  sent:    { label: 'Sent',     color: 'bg-blue-100 text-blue-700',   icon: <Mail size={11} /> },
  opened:  { label: 'Opened',   color: 'bg-purple-100 text-purple-700', icon: <CheckCircle size={11} /> },
  replied: { label: 'Replied',  color: 'bg-green-100 text-green-700', icon: <MessageSquare size={11} /> },
  bounced: { label: 'Bounced',  color: 'bg-red-100 text-red-600',     icon: <AlertCircle size={11} /> },
};

export default function CampaignDetail({ campaign, onClose, fetchLeads }: Props) {
  const [leads, setLeads] = useState<CampaignLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    fetchLeads(campaign.id)
      .then(setLeads)
      .finally(() => setLoading(false));
  }, [campaign.id, fetchLeads]);

  const counts = leads.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const filtered = filter === 'all' ? leads : leads.filter((l) => l.status === filter);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-bold">{campaign.name}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Created {new Date(campaign.created_at).toLocaleDateString()} ·{' '}
              <span className={`font-medium ${
                campaign.status === 'sent' ? 'text-green-600' :
                campaign.status === 'sending' ? 'text-blue-600' : 'text-gray-600'
              }`}>{campaign.status}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 mt-0.5">
            <X size={20} />
          </button>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-5 divide-x border-b text-center text-sm">
          {[
            { label: 'Total Leads', value: leads.length, color: 'text-gray-900' },
            { label: 'Sent',        value: counts.sent || 0,    color: 'text-blue-600' },
            { label: 'Opened',      value: counts.opened || 0,  color: 'text-purple-600' },
            { label: 'Replied',     value: counts.replied || 0, color: 'text-green-600' },
            { label: 'Bounced',     value: counts.bounced || 0, color: 'text-red-600' },
          ].map((s) => (
            <div key={s.label} className="py-3 px-2">
              <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 px-6 pt-3 pb-1 flex-wrap">
          {['all', 'pending', 'sent', 'replied', 'bounced'].map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition-colors ${
                filter === f ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {f === 'all' ? `All (${leads.length})` : `${f} (${counts[f] || 0})`}
            </button>
          ))}
        </div>

        {/* Lead list */}
        <div className="flex-1 overflow-y-auto px-6 py-2">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading leads…
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-center py-8 text-gray-400 text-sm">No leads in this filter.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b">
                  <th className="py-2 font-medium">Company</th>
                  <th className="py-2 font-medium">Email</th>
                  <th className="py-2 font-medium">Rating</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium text-right">Sent At</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => {
                  const st = STATUS_CONFIG[l.status] || STATUS_CONFIG.pending;
                  return (
                    <tr key={l.id} className="border-b hover:bg-gray-50">
                      <td className="py-2 font-medium text-gray-800">
                        {l.leads?.company_name || '—'}
                      </td>
                      <td className="py-2 text-gray-500 text-xs">{l.email_used || '—'}</td>
                      <td className="py-2 text-gray-600">
                        {l.leads?.star_rating ? `${l.leads.star_rating} ★` : '—'}
                      </td>
                      <td className="py-2">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${st.color}`}>
                          {st.icon} {st.label}
                        </span>
                      </td>
                      <td className="py-2 text-right text-xs text-gray-400">
                        {l.sent_at ? new Date(l.sent_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer workflow guide */}
        <div className="border-t px-6 py-3 bg-gray-50 rounded-b-xl">
          <p className="text-xs text-gray-500">
            <strong className="text-gray-700">Workflow:</strong>{' '}
            Draft → Test Send (verify email arrives) → Live Send → Check Replies (auto-updates status) → Follow up with Replied leads
          </p>
        </div>
      </div>
    </div>
  );
}

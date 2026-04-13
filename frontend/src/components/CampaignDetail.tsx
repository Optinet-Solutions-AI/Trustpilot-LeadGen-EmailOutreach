'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Campaign } from '../types/campaign';

interface CampaignLead {
  id: string;
  lead_id: string;
  email_used: string | null;
  status: string;
  sent_at: string | null;
  scheduled_at?: string | null;
  reply_snippet?: string | null;
  leads: { company_name: string; star_rating: number; country: string; category: string } | null;
}

interface CampaignStep {
  id: string;
  step_number: number;
  delay_days: number;
  template_subject: string;
}

interface Props {
  campaign: Campaign;
  onClose: () => void;
  fetchLeads: (id: string) => Promise<CampaignLead[]>;
  fetchSteps?: (id: string) => Promise<CampaignStep[]>;
  onDuplicate?: (campaignId: string) => Promise<void>;
}

const STATUS_CONFIG: Record<string, { label: string; classes: string; icon: string }> = {
  pending: { label: 'Pending', classes: 'bg-surface-container-high text-secondary',   icon: 'schedule' },
  sent:    { label: 'Sent',    classes: 'bg-blue-50 text-blue-700',                   icon: 'send' },
  opened:  { label: 'Opened',  classes: 'bg-[#ffd9de] text-[#b0004a]',               icon: 'drafts' },
  replied: { label: 'Replied', classes: 'bg-[#8ff9a8]/30 text-[#006630]',            icon: 'reply' },
  bounced: { label: 'Bounced', classes: 'bg-red-50 text-error',                      icon: 'unsubscribe' },
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatScheduleSummary(schedule: NonNullable<Campaign['sending_schedule']>): string {
  const dayLabels = schedule.days.map((d) => DAY_NAMES[d]).join(', ');
  return `${schedule.startHour} – ${schedule.endHour} · ${dayLabels} · up to ${schedule.dailyLimit} emails/day`;
}

export default function CampaignDetail({ campaign, onClose, fetchLeads, fetchSteps, onDuplicate }: Props) {
  const [leads, setLeads] = useState<CampaignLead[]>([]);
  const [steps, setSteps] = useState<CampaignStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [expandedReply, setExpandedReply] = useState<string | null>(null);
  const [showTemplate, setShowTemplate] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  useEffect(() => {
    fetchLeads(campaign.id).then(setLeads).finally(() => setLoading(false));
    if (fetchSteps) fetchSteps(campaign.id).then(setSteps).catch(() => {});
  }, [campaign.id, fetchLeads, fetchSteps]);

  const counts = leads.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const filtered = filter === 'all' ? leads : leads.filter((l) => l.status === filter);

  const totalSent = (counts.sent || 0) + (counts.opened || 0) + (counts.replied || 0);
  const replyRate = totalSent > 0 ? ((counts.replied || 0) / totalSent * 100).toFixed(1) : '0';
  const bounceRate = totalSent > 0 ? ((counts.bounced || 0) / (totalSent + (counts.bounced || 0)) * 100).toFixed(1) : '0';

  const handleDuplicate = async () => {
    if (!onDuplicate) return;
    setDuplicating(true);
    try { await onDuplicate(campaign.id); onClose(); } finally { setDuplicating(false); }
  };

  const statusClasses: Record<string, string> = {
    sent:      'bg-[#8ff9a8]/20 text-[#006630]',
    sending:   'bg-blue-50 text-blue-700',
    completed: 'bg-[#8ff9a8]/20 text-[#006630]',
    draft:     'bg-surface-container-high text-secondary',
    failed:    'bg-[#ffd9de] text-[#b0004a]',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface-container-lowest rounded-2xl ambient-shadow w-full max-w-4xl max-h-[85vh] flex flex-col border border-slate-100">

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-slate-100">
          <div>
            <h2
              className="text-xl font-extrabold text-on-surface"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              {campaign.name}
            </h2>
            <p className="text-xs text-secondary mt-0.5 flex items-center gap-2">
              Created {new Date(campaign.created_at).toLocaleDateString()}
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${statusClasses[campaign.status] || 'bg-surface-container-high text-secondary'}`}>
                {campaign.status}
              </span>
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-secondary hover:text-on-surface rounded-lg hover:bg-surface-container transition-colors">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-5 divide-x divide-slate-100 border-b border-slate-100">
          {[
            { label: 'Total Leads', value: leads.length,         sub: null,           color: 'text-on-surface' },
            { label: 'Sent',        value: totalSent,            sub: null,           color: 'text-blue-600' },
            { label: 'Replied',     value: counts.replied || 0,  sub: `${replyRate}%`, color: 'text-[#006630]' },
            { label: 'Bounced',     value: counts.bounced || 0,  sub: `${bounceRate}%`, color: 'text-error' },
            { label: 'Pending',     value: counts.pending || 0,  sub: null,           color: 'text-secondary' },
          ].map((s) => (
            <div key={s.label} className="py-4 px-4 text-center">
              <p className={`text-2xl font-extrabold ${s.color}`} style={{ fontFamily: 'Manrope, sans-serif' }}>{s.value}</p>
              <p className="text-xs text-secondary font-medium mt-0.5">
                {s.label}
                {s.sub && <span className="ml-1 font-bold text-on-surface">({s.sub})</span>}
              </p>
            </div>
          ))}
        </div>

        {/* Template toggle */}
        {campaign.template_subject && (
          <div className="px-6 pt-4">
            <button
              onClick={() => setShowTemplate(!showTemplate)}
              className="flex items-center gap-1.5 text-xs font-bold text-secondary hover:text-on-surface transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">{showTemplate ? 'expand_less' : 'expand_more'}</span>
              {showTemplate ? 'Hide Template' : 'View Template'}
            </button>
            {showTemplate && (
              <div className="mt-3 bg-surface-container rounded-xl p-4 text-sm">
                <p className="text-xs font-bold text-secondary uppercase tracking-wider mb-1">Subject</p>
                <p className="font-bold text-on-surface mb-3">{campaign.template_subject}</p>
                <p className="text-xs font-bold text-secondary uppercase tracking-wider mb-1">Body</p>
                <div
                  className="text-secondary text-xs prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: campaign.template_body || '' }}
                />
              </div>
            )}
          </div>
        )}

        {/* Follow-up sequence */}
        {steps.length > 0 && (
          <div className="px-6 pt-4">
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <p className="text-xs font-bold text-blue-700 mb-3 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[14px]">schedule_send</span>
                Follow-up Sequence ({steps.length} step{steps.length !== 1 ? 's' : ''})
              </p>
              <div className="space-y-2">
                {steps.map((s) => (
                  <div key={s.id} className="flex items-center gap-2.5 text-xs text-blue-700">
                    <span className="w-5 h-5 rounded-full bg-blue-200 text-blue-700 flex items-center justify-center text-[10px] font-bold shrink-0">
                      {s.step_number}
                    </span>
                    <span>After {s.delay_days} day{s.delay_days !== 1 ? 's' : ''}: {s.template_subject.slice(0, 60)}{s.template_subject.length > 60 ? '...' : ''}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Sending Schedule */}
        {campaign.sending_schedule && (
          <div className="px-6 pt-4">
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
              <p className="text-xs font-bold text-amber-700 mb-2 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[14px]">schedule</span>
                Sending Schedule
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-amber-800">
                <span>
                  <span className="font-bold">Window:</span>{' '}
                  {campaign.sending_schedule.startHour} – {campaign.sending_schedule.endHour}
                </span>
                <span>
                  <span className="font-bold">Days:</span>{' '}
                  {campaign.sending_schedule.days.map((d) => DAY_NAMES[d]).join(', ')}
                </span>
                <span>
                  <span className="font-bold">Daily limit:</span>{' '}
                  {campaign.sending_schedule.dailyLimit} emails/day
                </span>
                <span>
                  <span className="font-bold">Timezone:</span>{' '}
                  {campaign.sending_schedule.timezone}
                </span>
                {campaign.email_platform && (
                  <span>
                    <span className="font-bold">Managed by:</span>{' '}
                    {campaign.email_platform}
                    {campaign.platform_campaign_id && (
                      <span className="ml-1 text-amber-600 font-mono">({campaign.platform_campaign_id.slice(0, 8)}…)</span>
                    )}
                  </span>
                )}
              </div>
              {campaign.status === 'sending' && (
                <p className="mt-2 text-[11px] text-amber-600 flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]">info</span>
                  Campaign is active — emails are being delivered within the window above. You don't need to keep the app open.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex gap-2 px-6 pt-4 pb-2 flex-wrap">
          {['all', 'pending', 'sent', 'replied', 'bounced'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold capitalize transition-colors ${
                filter === f
                  ? 'primary-gradient text-on-primary'
                  : 'bg-surface-container text-secondary hover:bg-surface-container-high'
              }`}
            >
              {f === 'all' ? `All (${leads.length})` : `${f} (${counts[f] || 0})`}
            </button>
          ))}
        </div>

        {/* Lead list */}
        <div className="flex-1 overflow-y-auto px-6 py-2">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-secondary gap-2">
              <Loader2 size={16} className="animate-spin text-[#b0004a]" /> Loading leads...
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-center py-8 text-secondary text-sm">No leads in this filter.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-slate-100">
                  {['Company', 'Country', 'Email', 'Rating', 'Status', 'Sent / Scheduled'].map((h) => (
                    <th key={h} className={`py-3 text-xs font-bold uppercase tracking-wider text-secondary ${h === 'Sent / Scheduled' ? 'text-right' : ''}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => {
                  const st = STATUS_CONFIG[l.status] || STATUS_CONFIG.pending;
                  const hasReply = l.status === 'replied' && l.reply_snippet;
                  return (
                    <>
                      <tr
                        key={l.id}
                        className={`border-b border-slate-50 hover:bg-surface-container-low transition-colors ${hasReply ? 'cursor-pointer' : ''}`}
                        onClick={() => hasReply && setExpandedReply(expandedReply === l.id ? null : l.id)}
                      >
                        <td className="py-3 font-bold text-on-surface">
                          {l.leads?.company_name || '—'}
                          {hasReply && (
                            <span className="ml-1.5 material-symbols-outlined text-[14px] text-[#006630] align-middle">
                              {expandedReply === l.id ? 'expand_less' : 'expand_more'}
                            </span>
                          )}
                        </td>
                        <td className="py-3 text-secondary text-xs">{l.leads?.country || '—'}</td>
                        <td className="py-3 text-secondary text-xs">{l.email_used || '—'}</td>
                        <td className="py-3 font-bold text-[#b0004a] text-xs">
                          {l.leads?.star_rating ? `${l.leads.star_rating} ★` : '—'}
                        </td>
                        <td className="py-3">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${st.classes}`}>
                            <span className="material-symbols-outlined text-[12px]">{st.icon}</span>
                            {st.label}
                          </span>
                        </td>
                        <td className="py-3 text-right text-xs text-secondary">
                          {l.sent_at ? (
                            <span>{new Date(l.sent_at).toLocaleString()}</span>
                          ) : l.scheduled_at ? (
                            <span className="flex flex-col items-end gap-0.5">
                              <span className="text-amber-600 font-bold">
                                {new Date(l.scheduled_at) <= new Date()
                                  ? 'Sending soon…'
                                  : new Date(l.scheduled_at).toLocaleString()}
                              </span>
                              <span className="text-[10px] text-secondary">scheduled</span>
                            </span>
                          ) : l.status === 'pending' ? (
                            <span className="flex flex-col items-end gap-0.5">
                              <span className="text-orange-500 font-bold text-[11px]">Not scheduled</span>
                              <span className="text-[10px] text-secondary">already contacted</span>
                            </span>
                          ) : (
                            <span>—</span>
                          )}
                        </td>
                      </tr>
                      {hasReply && expandedReply === l.id && (
                        <tr key={`${l.id}-reply`}>
                          <td colSpan={6} className="py-2 px-4">
                            <div className="bg-[#8ff9a8]/20 border border-[#006630]/20 rounded-xl p-3 text-xs text-[#006630]">
                              <p className="font-bold mb-1 flex items-center gap-1">
                                <span className="material-symbols-outlined text-[13px]">reply</span>
                                Reply snippet:
                              </p>
                              <p>{l.reply_snippet}</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-100 px-6 py-4 bg-surface-container rounded-b-2xl">
          <p className="text-xs text-secondary">
            <span className="font-bold text-on-surface">Workflow:</span>{' '}
            Draft → Test Flight → Live Send → Check Replies → Follow up
          </p>
          {onDuplicate && (
            <button
              onClick={handleDuplicate}
              disabled={duplicating}
              className="flex items-center gap-2 border border-slate-200 text-secondary px-4 py-2 rounded-lg text-xs font-bold hover:bg-surface-container-high disabled:opacity-50 transition-colors"
            >
              <span className="material-symbols-outlined text-[14px]">content_copy</span>
              {duplicating ? 'Duplicating...' : 'Duplicate Campaign'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

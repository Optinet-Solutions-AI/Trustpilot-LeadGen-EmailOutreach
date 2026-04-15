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
  gmail_thread_id?: string | null;
  gmail_message_id?: string | null;
  leads: { company_name: string; star_rating: number; country: string; category: string } | null;
}

interface CampaignStep {
  id: string;
  step_number: number;
  delay_days: number;
  template_subject: string;
}

interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  bodyType: 'html' | 'plain';
}

interface ThreadData {
  threadId: string;
  messages: ThreadMessage[];
  senderAccount: string;
}

interface Props {
  campaign: Campaign;
  onClose: () => void;
  fetchLeads: (id: string) => Promise<CampaignLead[]>;
  fetchSteps?: (id: string) => Promise<CampaignStep[]>;
  onDuplicate?: (campaignId: string) => Promise<void>;
  getEmailThread?: (threadId: string) => Promise<ThreadData>;
}

const STATUS_CONFIG: Record<string, { label: string; classes: string; icon: string }> = {
  pending: { label: 'Pending', classes: 'bg-surface-container-high text-secondary',   icon: 'schedule' },
  sent:    { label: 'Sent',    classes: 'bg-blue-50 text-blue-700',                   icon: 'send' },
  opened:  { label: 'Opened',  classes: 'bg-[#ffd9de] text-[#b0004a]',               icon: 'drafts' },
  replied: { label: 'Replied', classes: 'bg-[#8ff9a8]/30 text-[#006630]',            icon: 'reply' },
  bounced: { label: 'Bounced', classes: 'bg-red-50 text-error',                      icon: 'unsubscribe' },
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseDisplayName(address: string): { name: string; email: string } {
  const match = address.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { name: address, email: address };
}

/** Render template tokens + resolve first spintax option */
function renderTemplate(text: string, lead: CampaignLead | null, campaign: Campaign): string {
  const company = lead?.leads?.company_name || 'your company';
  const domain  = lead?.email_used?.includes('@') ? lead.email_used.split('@')[1] : '';
  return text
    .replace(/\{\{company_name\}\}/gi, company)
    .replace(/\{\{star_rating\}\}/gi,  String(lead?.leads?.star_rating ?? ''))
    .replace(/\{\{country\}\}/gi,      lead?.leads?.country || '')
    .replace(/\{\{category\}\}/gi,     lead?.leads?.category || campaign.filter_category || '')
    .replace(/\{\{website_url\}\}/gi,  domain)
    .replace(/\{([^{}]+)\}/g, (_, opts) => opts.split('|')[0]);
}

export default function CampaignDetail({ campaign, onClose, fetchLeads, fetchSteps, onDuplicate, getEmailThread }: Props) {
  const [leads, setLeads]   = useState<CampaignLead[]>([]);
  const [steps, setSteps]   = useState<CampaignStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState<string>('all');
  const [showTemplate, setShowTemplate] = useState(false);
  const [duplicating, setDuplicating]   = useState(false);

  // Message panel
  const [activeLead,    setActiveLead]    = useState<CampaignLead | null>(null);
  const [thread,        setThread]        = useState<ThreadData | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);

  useEffect(() => {
    fetchLeads(campaign.id).then(setLeads).finally(() => setLoading(false));
    if (fetchSteps) fetchSteps(campaign.id).then(setSteps).catch(() => {});
  }, [campaign.id, fetchLeads, fetchSteps]);

  const counts = leads.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const filtered = filter === 'all' ? leads : leads.filter((l) => l.status === filter);

  const totalSent  = (counts.sent || 0) + (counts.opened || 0) + (counts.replied || 0);
  const replyRate  = totalSent > 0 ? ((counts.replied || 0) / totalSent * 100).toFixed(1) : '0';
  const bounceRate = totalSent > 0 ? ((counts.bounced || 0) / (totalSent + (counts.bounced || 0)) * 100).toFixed(1) : '0';

  const handleDuplicate = async () => {
    if (!onDuplicate) return;
    setDuplicating(true);
    try { await onDuplicate(campaign.id); onClose(); } finally { setDuplicating(false); }
  };

  const openPanel = async (lead: CampaignLead) => {
    setActiveLead(lead);
    setThread(null);
    if (lead.gmail_thread_id && getEmailThread) {
      setThreadLoading(true);
      try { setThread(await getEmailThread(lead.gmail_thread_id)); }
      catch { setThread(null); }
      finally { setThreadLoading(false); }
    }
  };

  const closePanel = () => { setActiveLead(null); setThread(null); };

  const statusClasses: Record<string, string> = {
    sent:      'bg-[#8ff9a8]/20 text-[#006630]',
    sending:   'bg-blue-50 text-blue-700',
    completed: 'bg-[#8ff9a8]/20 text-[#006630]',
    draft:     'bg-surface-container-high text-secondary',
    failed:    'bg-[#ffd9de] text-[#b0004a]',
  };

  // Rendered template for the active lead (used when no real thread)
  const renderedSubject = activeLead ? renderTemplate(campaign.template_subject || '', activeLead, campaign) : '';
  const renderedBody    = activeLead
    ? renderTemplate(campaign.template_body || '', activeLead, campaign).replace(/<[^>]+>/g, '').trim()
    : '';

  // First real thread message (if available)
  const firstMsg = thread?.messages[0] ?? null;

  return (
    <div className={`flex w-full h-full ${activeLead ? 'overflow-hidden' : 'overflow-y-auto'}`}>

      {/* ── Left: main campaign content ── */}
      <div className={`${activeLead ? 'flex-1 min-w-0 overflow-y-auto' : 'w-full'} px-10 py-10 space-y-6`}>

        {/* Breadcrumb */}
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="flex items-center gap-1.5 text-secondary hover:text-[#b0004a] font-semibold text-sm transition-colors">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            All Campaigns
          </button>
          <span className="text-slate-300 text-sm">/</span>
          <span className="text-sm font-bold text-on-surface">{campaign.name}</span>
          <span className={`ml-1 px-2 py-0.5 rounded-full text-xs font-bold ${statusClasses[campaign.status] || 'bg-surface-container-high text-secondary'}`}>
            {campaign.status}
          </span>
        </div>

        <div className="bg-surface-container-lowest rounded-2xl ambient-shadow border border-slate-100">

          {/* Header */}
          <div className="flex items-start justify-between px-6 py-5 border-b border-slate-100">
            <div>
              <h2 className="text-2xl font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                {campaign.name}
              </h2>
              <p className="text-xs text-secondary mt-1">
                Created {new Date(campaign.created_at).toLocaleDateString()}
                {campaign.email_platform && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-surface-container text-secondary font-semibold">
                    via {campaign.email_platform}
                  </span>
                )}
              </p>
            </div>
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

          {/* Stats bar */}
          <div className="grid grid-cols-5 divide-x divide-slate-100 border-b border-slate-100">
            {[
              { label: 'Total Leads', value: leads.length,        sub: null,             color: 'text-on-surface' },
              { label: 'Sent',        value: totalSent,           sub: null,             color: 'text-blue-600'  },
              { label: 'Replied',     value: counts.replied || 0, sub: `${replyRate}%`,  color: 'text-[#006630]' },
              { label: 'Bounced',     value: counts.bounced || 0, sub: `${bounceRate}%`, color: 'text-error'     },
              { label: 'Pending',     value: counts.pending || 0, sub: null,             color: 'text-secondary' },
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

          {/* Sending schedule */}
          {campaign.sending_schedule && (
            <div className="px-6 pt-4">
              <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
                <p className="text-xs font-bold text-amber-700 mb-2 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[14px]">schedule</span>
                  Sending Schedule
                </p>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-amber-800">
                  <span><span className="font-bold">Window:</span> {campaign.sending_schedule.startHour} – {campaign.sending_schedule.endHour}</span>
                  <span><span className="font-bold">Days:</span> {campaign.sending_schedule.days.map((d) => DAY_NAMES[d]).join(', ')}</span>
                  <span><span className="font-bold">Daily limit:</span> {campaign.sending_schedule.dailyLimit} emails/day</span>
                  <span><span className="font-bold">Timezone:</span> {campaign.sending_schedule.timezone}</span>
                </div>
              </div>
            </div>
          )}

          {/* Filter tabs */}
          <div className="flex gap-2 px-6 pt-4 pb-2 flex-wrap">
            {(['all', 'pending', 'sent', 'replied', 'bounced'] as const).map((f) => (
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
          <div className="px-6 py-2">
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
                    {['Company', 'Country', 'Email', 'Rating', 'Status', 'Sent / Scheduled', ''].map((h) => (
                      <th key={h} className={`py-3 text-xs font-bold uppercase tracking-wider text-secondary ${h === 'Sent / Scheduled' ? 'text-right' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => {
                    const st = STATUS_CONFIG[l.status] || STATUS_CONFIG.pending;
                    const isActive = activeLead?.id === l.id;
                    return (
                      <tr
                        key={l.id}
                        className={`border-b border-slate-50 cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-[#ffd9de]/20'
                            : 'hover:bg-surface-container-low'
                        }`}
                        onClick={() => openPanel(l)}
                      >
                        <td className="py-3 font-bold text-on-surface">{l.leads?.company_name || '—'}</td>
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
                            new Date(l.sent_at).toLocaleString()
                          ) : l.scheduled_at ? (
                            <span className="flex flex-col items-end gap-0.5">
                              <span className="text-amber-600 font-bold">
                                {new Date(l.scheduled_at) <= new Date() ? 'Sending soon…' : new Date(l.scheduled_at).toLocaleString()}
                              </span>
                              <span className="text-[10px] text-secondary">scheduled</span>
                            </span>
                          ) : l.status === 'pending' ? (
                            <span className="flex flex-col items-end gap-0.5">
                              <span className="text-orange-500 font-bold text-[11px]">Not scheduled</span>
                              <span className="text-[10px] text-secondary">already contacted</span>
                            </span>
                          ) : '—'}
                        </td>
                        <td className="py-3 pl-2">
                          <span className={`material-symbols-outlined text-[16px] transition-colors ${isActive ? 'text-[#b0004a]' : 'text-slate-300'}`}>
                            {isActive ? 'chevron_right' : 'chevron_right'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center border-t border-slate-100 px-6 py-4 bg-surface-container rounded-b-2xl">
            <p className="text-xs text-secondary">
              <span className="font-bold text-on-surface">Workflow:</span>{' '}
              Draft → Test Flight → Live Send → Check Replies → Follow up
            </p>
            <p className="ml-auto text-xs text-secondary flex items-center gap-1">
              <span className="material-symbols-outlined text-[13px]">info</span>
              Click any lead to view the sent message
            </p>
          </div>
        </div>
      </div>

      {/* ── Right: Actual Sent Message panel ── */}
      {activeLead && (
        <div className="w-[380px] flex-shrink-0 flex flex-col bg-white border-l border-slate-100 overflow-y-auto">

          {/* Panel header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
            <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Actual Sent Message
            </p>
            <button onClick={closePanel} className="p-1.5 rounded-lg hover:bg-surface-container transition-colors">
              <span className="material-symbols-outlined text-[18px] text-secondary">close</span>
            </button>
          </div>

          {/* Lead info */}
          <div className="px-5 py-4 flex items-center gap-3 border-b border-slate-100">
            <div className="w-10 h-10 rounded-full bg-[#ffd9de] flex items-center justify-center text-[#b0004a] font-extrabold text-base flex-shrink-0">
              {(activeLead.leads?.company_name || activeLead.email_used || '?').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-on-surface truncate">{activeLead.leads?.company_name || '—'}</p>
              <p className="text-xs text-secondary truncate">{activeLead.email_used || '—'}</p>
            </div>
            {activeLead.leads?.star_rating ? (
              <span className="text-xs font-bold text-[#b0004a] flex-shrink-0">{activeLead.leads.star_rating} ★</span>
            ) : null}
          </div>

          {/* Message body */}
          <div className="flex-1">
            {threadLoading ? (
              <div className="flex items-center justify-center py-14 gap-2 text-secondary text-sm">
                <span className="material-symbols-outlined text-[#b0004a] text-[20px] animate-spin">progress_activity</span>
                Loading thread…
              </div>
            ) : thread && thread.messages.length > 0 ? (
              /* Real Gmail thread */
              <div>
                {thread.messages.map((msg, idx) => {
                  const { name: fromName, email: fromEmail } = parseDisplayName(msg.from);
                  return (
                    <div key={msg.id} className={idx > 0 ? 'border-t border-slate-100' : ''}>
                      {idx === 0 ? (
                        <div className="px-5 pt-4 pb-2">
                          <p className="text-sm font-bold text-on-surface leading-snug">{msg.subject}</p>
                        </div>
                      ) : (
                        <div className="px-5 pt-4 pb-2 flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-[#ffd9de] flex items-center justify-center text-[#b0004a] text-[10px] font-bold flex-shrink-0">
                            {(fromName || fromEmail).charAt(0).toUpperCase()}
                          </div>
                          <p className="text-xs font-bold text-on-surface flex-1 truncate">{fromName || fromEmail}</p>
                          <span className="text-[10px] text-slate-400 flex-shrink-0">
                            {new Date(msg.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                          </span>
                        </div>
                      )}
                      <div className="px-5 pb-4">
                        {msg.body ? (
                          <div
                            className="email-body text-secondary text-xs overflow-auto"
                            style={{ maxHeight: idx === 0 ? '240px' : '160px' }}
                            dangerouslySetInnerHTML={{ __html: msg.body }}
                          />
                        ) : (
                          <p className="text-xs text-secondary italic">{msg.snippet}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Rendered template fallback */
              <div className="px-5 pt-4 pb-4">
                <p className="text-sm font-bold text-on-surface leading-snug mb-3">{renderedSubject}</p>
                {renderedBody ? (
                  <div
                    className="email-body text-secondary text-xs"
                    dangerouslySetInnerHTML={{ __html: renderedBody }}
                  />
                ) : (
                  <p className="text-xs text-secondary italic">No message body available.</p>
                )}
                {activeLead.reply_snippet && (
                  <div className="mt-4 border-t border-slate-100 pt-4 bg-[#8ff9a8]/20 rounded-xl p-3">
                    <p className="text-xs font-bold text-[#006630] mb-1 flex items-center gap-1">
                      <span className="material-symbols-outlined text-[13px]">reply</span>
                      Reply received:
                    </p>
                    <p className="text-xs text-[#006630]">{activeLead.reply_snippet}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Metadata */}
          <div className="border-t border-slate-100 px-5 py-4">
            <p className="text-[10px] font-extrabold text-secondary uppercase tracking-wider mb-3">Metadata</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <p className="text-[10px] text-secondary">Time Sent</p>
                <p className="text-xs font-semibold text-on-surface">
                  {activeLead.sent_at
                    ? new Date(activeLead.sent_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
                    : '—'}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-secondary">Send Account</p>
                <p className="text-xs font-semibold text-on-surface truncate">
                  {thread?.senderAccount || '—'}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-secondary">Status</p>
                <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_CONFIG[activeLead.status]?.classes || 'bg-surface-container-high text-secondary'}`}>
                  <span className="material-symbols-outlined text-[10px]">{STATUS_CONFIG[activeLead.status]?.icon || 'schedule'}</span>
                  {STATUS_CONFIG[activeLead.status]?.label || 'Unknown'}
                </span>
              </div>
              <div>
                <p className="text-[10px] text-secondary">Thread ID</p>
                <p className="text-xs font-semibold text-on-surface font-mono truncate">
                  {activeLead.gmail_thread_id ? `${activeLead.gmail_thread_id.slice(0, 10)}…` : '—'}
                </p>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="border-t border-slate-100 px-5 py-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                const subject = firstMsg?.subject || renderedSubject;
                const body    = firstMsg
                  ? (firstMsg.bodyType === 'html' ? firstMsg.body.replace(/<[^>]+>/g, '') : firstMsg.body)
                  : renderedBody;
                navigator.clipboard?.writeText(`Subject: ${subject}\n\n${body}`);
              }}
              className="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold text-secondary border border-slate-200 rounded-lg py-2 hover:bg-surface-container transition-colors"
            >
              <span className="material-symbols-outlined text-[13px]">content_copy</span>
              Copy Message
            </button>
          </div>

          {/* Optimization suggestion */}
          {(activeLead.status === 'sent' || activeLead.status === 'pending') && (
            <div className="mx-4 mb-4 bg-white rounded-xl border border-slate-100 overflow-hidden">
              <div className="flex items-start gap-3 p-4">
                <div className="w-7 h-7 rounded-xl bg-[#e6f4ec] flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-[14px] text-[#006630]">tips_and_updates</span>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-extrabold text-on-surface mb-1">Optimization Suggestion</p>
                  <p className="text-[11px] text-secondary leading-relaxed">
                    {activeLead.status === 'sent'
                      ? 'No reply yet. Adding a follow-up step to the sequence can increase response rates by up to 40%.'
                      : 'This lead is pending. Check that sending schedule windows are configured correctly.'}
                  </p>
                  {steps.length === 0 && activeLead.status === 'sent' && (
                    <button type="button" className="mt-2 text-[10px] font-extrabold text-[#006630] uppercase tracking-wider hover:underline">
                      Add to Sequence →
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '../api/client';

type Folder = 'inbox' | 'sent' | 'spam';

const FOLDERS: { key: Folder; icon: string; label: string }[] = [
  { key: 'inbox', icon: 'inbox',               label: 'Replies' },
  { key: 'sent',  icon: 'send',                label: 'Sent'    },
  { key: 'spam',  icon: 'report_gmailerrorred', label: 'Spam'   },
];

const STAGE_LEGEND = [
  { label: 'New Lead',   color: 'bg-blue-100 text-blue-700'           },
  { label: 'Replied',    color: 'bg-[#8ff9a8]/40 text-[#006630]'      },
  { label: 'Interested', color: 'bg-amber-100 text-amber-700'         },
  { label: 'Closed',     color: 'bg-surface-container text-secondary'  },
];

interface ReplyLead {
  id: string;
  company_name: string;
  primary_email: string;
  trustpilot_email?: string;
  website_email?: string;
  country?: string;
  category?: string;
  outreach_status: string;
  updated_at?: string;
}

export default function Inbox() {
  const router = useRouter();
  const [folder, setFolder] = useState<Folder>('inbox');
  const [replies, setReplies] = useState<ReplyLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (folder !== 'inbox') return;
    setLoading(true);
    api.get('/leads', { params: { status: 'replied', limit: 100, sortBy: 'updated_at', sortDir: 'desc' } })
      .then((res) => setReplies(res.data.data?.leads ?? []))
      .catch(() => setReplies([]))
      .finally(() => setLoading(false));
  }, [folder]);

  const selectedLead = replies.find((r) => r.id === selected);

  return (
    <div className="flex h-full" style={{ height: 'calc(100vh - 4rem)' }}>

      {/* Left pane — folder nav */}
      <div className="w-56 border-r border-slate-100 bg-surface-container-lowest flex flex-col shrink-0">
        <div className="px-5 py-6 border-b border-slate-100">
          <h2 className="text-lg font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>Inbox</h2>
          <p className="text-xs text-secondary mt-0.5">Reply tracking</p>
        </div>
        <nav className="flex-1 px-2 py-4 space-y-0.5">
          {FOLDERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFolder(f.key); setSelected(null); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                f.key === folder
                  ? 'bg-[#ffd9de]/20 text-[#b0004a]'
                  : 'text-secondary hover:bg-surface-container-high'
              } ${f.key !== 'inbox' ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}`}
            >
              <span className="material-symbols-outlined text-[18px]">{f.icon}</span>
              <span className="flex-1 text-left">{f.label}</span>
              {f.key === 'inbox' && replies.length > 0 && (
                <span className="text-[10px] font-black bg-[#b0004a] text-white rounded-full w-5 h-5 flex items-center justify-center">
                  {replies.length > 99 ? '99+' : replies.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Lead stage legend */}
        <div className="px-5 py-4 border-t border-slate-100">
          <p className="text-[10px] font-extrabold uppercase tracking-wider text-secondary mb-3">Lead Stage</p>
          {STAGE_LEGEND.map(({ label, color }) => (
            <div key={label} className="flex items-center gap-2 mb-2">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${color}`}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Center — thread list */}
      <div className="w-80 border-r border-slate-100 flex flex-col bg-[#f8f9fa] shrink-0 overflow-hidden">
        <div className="px-4 py-4 border-b border-slate-100 bg-white">
          <p className="text-xs font-extrabold uppercase tracking-wider text-secondary">
            {folder === 'inbox' ? `${replies.length} Replies` : 'No messages'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 gap-2 text-secondary text-sm">
              <span className="material-symbols-outlined text-[#b0004a] text-[20px] animate-spin">progress_activity</span>
              Loading…
            </div>
          ) : replies.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <span className="material-symbols-outlined text-slate-300 text-[36px] mb-3">mark_email_unread</span>
              <p className="text-sm font-semibold text-secondary">No replies yet</p>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                Leads that reply to your campaigns will appear here automatically.
              </p>
            </div>
          ) : (
            replies.map((lead) => (
              <button
                key={lead.id}
                onClick={() => setSelected(lead.id === selected ? null : lead.id)}
                className={`w-full text-left px-4 py-4 border-b border-slate-100 transition-colors hover:bg-white ${
                  selected === lead.id ? 'bg-white border-l-2 border-l-[#b0004a]' : ''
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-bold text-on-surface truncate max-w-[160px]">{lead.company_name}</span>
                  <span className="text-[10px] text-slate-400 flex-shrink-0">
                    {lead.updated_at ? new Date(lead.updated_at).toLocaleDateString() : ''}
                  </span>
                </div>
                <p className="text-xs text-secondary truncate">{lead.primary_email || lead.trustpilot_email || lead.website_email || 'No email'}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="px-1.5 py-0.5 text-[9px] font-black uppercase rounded-full bg-[#8ff9a8]/40 text-[#006630]">
                    Replied
                  </span>
                  {lead.country && <span className="text-[10px] text-slate-400">{lead.country}</span>}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right — detail pane */}
      <div className="flex-1 flex flex-col bg-[#f8f9fa] overflow-hidden">
        {selectedLead ? (
          <div className="flex flex-col h-full">
            {/* Detail header */}
            <div className="px-6 py-5 border-b border-slate-100 bg-white flex items-center justify-between">
              <div>
                <h3 className="text-lg font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                  {selectedLead.company_name}
                </h3>
                <p className="text-sm text-secondary mt-0.5">
                  {selectedLead.primary_email || selectedLead.trustpilot_email || selectedLead.website_email}
                </p>
              </div>
              <button
                onClick={() => router.push(`/leads/${selectedLead.id}`)}
                className="flex items-center gap-2 px-4 py-2 primary-gradient text-on-primary rounded-lg text-sm font-bold ambient-shadow"
              >
                <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                View Lead
              </button>
            </div>

            {/* Reply info */}
            <div className="flex-1 px-6 py-6 overflow-y-auto space-y-4">
              <div className="bg-[#8ff9a8]/10 border border-[#006630]/20 rounded-xl p-5 flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-[#8ff9a8]/30 flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-[#006630] text-[20px]">reply</span>
                </div>
                <div>
                  <p className="text-sm font-bold text-[#006630] mb-1">Reply Detected</p>
                  <p className="text-sm text-secondary leading-relaxed">
                    This lead has replied to your outreach. Check their Activity Timeline for the reply snippet and conversation history.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {[
                  { label: 'Country',   value: selectedLead.country   || '—' },
                  { label: 'Category',  value: selectedLead.category  || '—' },
                  { label: 'Email',     value: selectedLead.primary_email || selectedLead.trustpilot_email || '—' },
                  { label: 'Status',    value: 'Replied' },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-white rounded-xl p-4 ambient-shadow">
                    <p className="text-xs font-bold text-secondary uppercase tracking-wider mb-1">{label}</p>
                    <p className="text-sm font-semibold text-on-surface truncate">{value}</p>
                  </div>
                ))}
              </div>

              <div className="bg-white rounded-xl p-5 ambient-shadow">
                <p className="text-xs font-bold text-secondary uppercase tracking-wider mb-3">Next Steps</p>
                <div className="space-y-2.5">
                  {[
                    { icon: 'timeline',   text: 'Check Activity Timeline for reply content and conversation thread' },
                    { icon: 'edit_note',  text: 'Add a note with your follow-up plan or call outcome' },
                    { icon: 'person_pin', text: 'Update lead status to Interested or Converted as you progress' },
                    { icon: 'event',      text: 'Schedule a follow-up reminder so nothing falls through the cracks' },
                  ].map(({ icon, text }) => (
                    <div key={text} className="flex items-start gap-3">
                      <span className="material-symbols-outlined text-[#b0004a] text-[16px] mt-0.5">{icon}</span>
                      <p className="text-xs text-secondary leading-relaxed">{text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
            <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-5">
              <span className="material-symbols-outlined text-[32px] text-secondary">mark_email_read</span>
            </div>
            <h3 className="text-xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {replies.length > 0 ? 'Select a reply to view details' : 'Waiting for replies'}
            </h3>
            <p className="text-sm text-secondary max-w-md leading-relaxed mb-6">
              {replies.length > 0
                ? 'Click any lead on the left to see their reply details and next-step recommendations.'
                : 'When leads reply to your campaigns, they\'ll appear here automatically. Campaign stats also show open/reply counts in real time.'}
            </p>
            {replies.length === 0 && (
              <div className="flex flex-col gap-3 items-center">
                <div className="flex items-center gap-3 px-5 py-3 bg-white rounded-xl border border-slate-100 ambient-shadow text-sm text-secondary">
                  <span className="material-symbols-outlined text-[#b0004a] text-[20px]">campaign</span>
                  <span>Campaign replies → <span className="font-bold text-on-surface">Campaigns → View Details → Lead Status</span></span>
                </div>
                <div className="flex items-center gap-3 px-5 py-3 bg-white rounded-xl border border-slate-100 ambient-shadow text-sm text-secondary">
                  <span className="material-symbols-outlined text-[#b0004a] text-[20px]">person</span>
                  <span>Individual activity → <span className="font-bold text-on-surface">Lead Matrix → Lead Profile → Activity</span></span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import api from '../api/client';

type Folder = 'replies' | 'sent';

const FOLDERS: { key: Folder; icon: string; label: string }[] = [
  { key: 'replies', icon: 'reply',  label: 'Replies'    },
  { key: 'sent',    icon: 'send',   label: 'Sent Emails' },
];

interface CampaignMessage {
  id: string;
  campaign_id: string;
  campaign_name: string;
  lead_id: string;
  company_name: string;
  country: string;
  email_used: string | null;
  status: string;
  sent_at: string | null;
  reply_snippet: string | null;
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
}

interface ThreadMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  bodyType: 'html' | 'plain';
  unread: boolean;
  labels: string[];
}

interface ThreadData {
  threadId: string;
  messages: ThreadMessage[];
  senderAccount: string;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function parseDisplayName(address: string): { name: string; email: string } {
  const match = address.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { name: address, email: address };
}

const STATUS_BADGE: Record<string, { label: string; classes: string }> = {
  replied:  { label: 'Replied',  classes: 'bg-[#8ff9a8]/30 text-[#006630]' },
  opened:   { label: 'Opened',   classes: 'bg-[#ffd9de]/60 text-[#b0004a]' },
  sent:     { label: 'Sent',     classes: 'bg-blue-50 text-blue-700' },
  bounced:  { label: 'Bounced',  classes: 'bg-red-50 text-error' },
  pending:  { label: 'Pending',  classes: 'bg-surface-container text-secondary' },
};

export default function Inbox() {
  const [folder, setFolder] = useState<Folder>('replies');
  const [messages, setMessages] = useState<CampaignMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [selectedMsg, setSelectedMsg] = useState<CampaignMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Draggable panel width
  const [panelWidth, setPanelWidth] = useState(480);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: panelWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX;
      // Max = viewport minus left nav (224px) + message list (320px) + drag handle (6px) + 16px breathing room
      const maxWidth = window.innerWidth - 224 - 320 - 6 - 16;
      const next = Math.min(Math.max(dragRef.current.startWidth + delta, 320), maxWidth);
      setPanelWidth(next);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  const fetchMessages = useCallback(() => {
    setLoading(true);
    setError(null);
    setSelectedId(null);
    setThread(null);
    setSelectedMsg(null);
    api.get('/inbox/campaign-replies', { params: { folder } })
      .then((res) => setMessages(res.data.data ?? []))
      .catch((err) => {
        setError(err?.response?.data?.error || err.message || 'Failed to load messages');
        setMessages([]);
      })
      .finally(() => setLoading(false));
  }, [folder]);

  useEffect(() => { fetchMessages(); }, [fetchMessages]);

  const openMessage = async (msg: CampaignMessage) => {
    if (selectedId === msg.id) return;
    setSelectedId(msg.id);
    setSelectedMsg(msg);
    setThread(null);

    if (!msg.gmail_thread_id) return; // No thread to load

    setThreadLoading(true);
    try {
      const res = await api.get(`/inbox/thread/${msg.gmail_thread_id}`);
      setThread(res.data.data);
    } catch {
      setThread(null);
    } finally {
      setThreadLoading(false);
    }
  };

  const repliesCount = messages.filter(m => m.status === 'replied').length;

  return (
    <div className="flex h-full" style={{ height: 'calc(100vh - 4rem)' }}>

      {/* Left pane — folder nav */}
      <div className="w-56 border-r border-slate-100 bg-surface-container-lowest flex flex-col shrink-0">
        <div className="px-5 py-6 border-b border-slate-100">
          <h2 className="text-lg font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>Outreach Inbox</h2>
          <p className="text-xs text-secondary mt-0.5">Campaign replies &amp; sent</p>
        </div>

        <nav className="flex-1 px-2 py-4 space-y-0.5">
          {FOLDERS.map((f) => {
            const badge = f.key === 'replies' ? repliesCount : 0;
            return (
              <button
                key={f.key}
                onClick={() => setFolder(f.key)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                  f.key === folder
                    ? 'bg-[#ffd9de]/20 text-[#b0004a]'
                    : 'text-secondary hover:bg-surface-container-high'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">{f.icon}</span>
                <span className="flex-1 text-left">{f.label}</span>
                {badge > 0 && (
                  <span className="text-[10px] font-black bg-[#b0004a] text-white rounded-full w-5 h-5 flex items-center justify-center">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="px-5 py-4 border-t border-slate-100">
          <p className="text-[10px] text-secondary leading-relaxed">
            Only showing emails related to your outreach campaigns.
          </p>
        </div>
      </div>

      {/* Center — message list */}
      <div className="w-80 border-r border-slate-100 flex flex-col bg-[#f8f9fa] shrink-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 bg-white flex items-center justify-between">
          <p className="text-xs font-extrabold uppercase tracking-wider text-secondary">
            {loading ? 'Loading…' : `${messages.length} message${messages.length !== 1 ? 's' : ''}`}
          </p>
          <button
            onClick={fetchMessages}
            disabled={loading}
            className="text-secondary hover:text-[#b0004a] transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <span className={`material-symbols-outlined text-[16px] ${loading ? 'animate-spin' : ''}`}>
              {loading ? 'progress_activity' : 'refresh'}
            </span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 gap-2 text-secondary text-sm">
              <span className="material-symbols-outlined text-[#b0004a] text-[20px] animate-spin">progress_activity</span>
              Loading…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
              <span className="material-symbols-outlined text-slate-300 text-[36px]">error_outline</span>
              <p className="text-sm font-semibold text-secondary">Could not load messages</p>
              <p className="text-xs text-slate-400 leading-relaxed">{error}</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <span className="material-symbols-outlined text-slate-300 text-[36px] mb-3">
                {folder === 'replies' ? 'mark_email_unread' : 'send'}
              </span>
              <p className="text-sm font-semibold text-secondary">
                {folder === 'replies' ? 'No replies yet' : 'No emails sent yet'}
              </p>
              <p className="text-xs text-slate-400 mt-1">
                {folder === 'replies'
                  ? 'Replies from leads will appear here.'
                  : 'Sent campaign emails will appear here.'}
              </p>
            </div>
          ) : (
            messages.map((msg) => {
              const isSelected = selectedId === msg.id;
              const badge = STATUS_BADGE[msg.status] || STATUS_BADGE.sent;
              return (
                <button
                  key={msg.id}
                  onClick={() => openMessage(msg)}
                  className={`w-full text-left px-4 py-3.5 border-b border-slate-100 transition-colors hover:bg-white ${
                    isSelected ? 'bg-white border-l-2 border-l-[#b0004a]' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-bold text-on-surface truncate max-w-[160px]">
                      {msg.company_name}
                    </span>
                    <span className="text-[10px] text-slate-400 flex-shrink-0 ml-1">{formatDate(msg.sent_at)}</span>
                  </div>
                  <p className="text-xs text-secondary truncate mb-1.5">{msg.campaign_name}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-slate-400 truncate">{msg.email_used || '—'}</span>
                    <span className={`flex-shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${badge.classes}`}>
                      {badge.label}
                    </span>
                  </div>
                  {msg.status === 'replied' && msg.reply_snippet && (
                    <p className="text-[11px] text-[#006630] truncate mt-1 italic">{msg.reply_snippet}</p>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right — thread / detail pane */}
      <div className="flex-1 flex overflow-hidden bg-[#f8f9fa]">

        {!selectedMsg ? (
          /* Empty state */
          <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
            <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-5">
              <span className="material-symbols-outlined text-[32px] text-secondary">
                {folder === 'replies' ? 'mark_email_read' : 'send'}
              </span>
            </div>
            <h3 className="text-xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {messages.length > 0 ? 'Select a message' : folder === 'replies' ? 'No replies yet' : 'No sent emails'}
            </h3>
            <p className="text-sm text-secondary max-w-md leading-relaxed">
              {messages.length > 0
                ? 'Click any message to read the full conversation thread.'
                : folder === 'replies'
                  ? 'When leads reply to your outreach emails, they will appear here.'
                  : 'Sent outreach emails will appear here once campaigns are running.'}
            </p>
          </div>
        ) : (
          <>
            {/* Spacer — fills remaining space to the left of the panel */}
            <div className="flex-1 min-w-0" />

            {/* Drag handle */}
            <div
              onMouseDown={onDragStart}
              className="w-1.5 flex-shrink-0 self-stretch cursor-col-resize bg-slate-100 hover:bg-[#b0004a]/30 active:bg-[#b0004a]/50 transition-colors"
              title="Drag to resize panel"
            />

            {/* Detail panel — draggable width */}
            <div className="flex flex-col bg-white overflow-y-auto h-full flex-shrink-0 border-l border-slate-100" style={{ width: panelWidth }}>

            {/* Panel header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
              <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                {thread ? `Thread (${thread.messages.length} message${thread.messages.length !== 1 ? 's' : ''})` : 'Message Detail'}
              </p>
              <button onClick={() => { setSelectedId(null); setSelectedMsg(null); setThread(null); }} className="p-1.5 rounded-lg hover:bg-surface-container transition-colors">
                <span className="material-symbols-outlined text-[18px] text-secondary">close</span>
              </button>
            </div>

            {/* Lead info */}
            <div className="px-5 py-4 flex items-center gap-3 border-b border-slate-100">
              <div className="w-10 h-10 rounded-full bg-[#ffd9de] flex items-center justify-center text-[#b0004a] font-extrabold text-base flex-shrink-0">
                {(selectedMsg.company_name || selectedMsg.email_used || '?').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-on-surface truncate">{selectedMsg.company_name || '—'}</p>
                <p className="text-xs text-secondary truncate">{selectedMsg.email_used || '—'}</p>
              </div>
              <span className={`flex-shrink-0 text-[10px] font-bold px-2.5 py-1 rounded-full ${STATUS_BADGE[selectedMsg.status]?.classes || ''}`}>
                {STATUS_BADGE[selectedMsg.status]?.label || selectedMsg.status}
              </span>
            </div>

            {/* Message body */}
            <div className="flex-1">
              {threadLoading ? (
                <div className="flex items-center justify-center py-14 gap-2 text-secondary text-sm">
                  <span className="material-symbols-outlined text-[#b0004a] text-[20px] animate-spin">progress_activity</span>
                  Loading thread…
                </div>
              ) : thread && thread.messages.length > 0 ? (
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
                              dangerouslySetInnerHTML={{ __html: msg.bodyType === 'html' ? msg.body : msg.body.replace(/\n/g, '<br>') }}
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
                /* No thread — show reply snippet if available */
                <div className="px-5 pt-4 pb-4">
                  {selectedMsg.reply_snippet && (
                    <div className="bg-[#8ff9a8]/20 border border-[#006630]/20 rounded-xl p-3 mb-3">
                      <p className="text-xs font-bold text-[#006630] mb-1 flex items-center gap-1">
                        <span className="material-symbols-outlined text-[13px]">reply</span>
                        Reply received:
                      </p>
                      <p className="text-xs text-[#006630]">{selectedMsg.reply_snippet}</p>
                    </div>
                  )}
                  <p className="text-xs text-slate-400 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[13px]">info</span>
                    Full thread not available — Gmail thread ID not recorded for this send.
                  </p>
                </div>
              )}
            </div>

            {/* Metadata */}
            <div className="border-t border-slate-100 px-5 py-4">
              <p className="text-[10px] font-extrabold text-secondary uppercase tracking-wider mb-3">Metadata</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <div>
                  <p className="text-[10px] text-secondary">Campaign</p>
                  <p className="text-xs font-semibold text-on-surface truncate">{selectedMsg.campaign_name || '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-secondary">Time Sent</p>
                  <p className="text-xs font-semibold text-on-surface">
                    {selectedMsg.sent_at
                      ? new Date(selectedMsg.sent_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
                      : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-secondary">Send Account</p>
                  <p className="text-xs font-semibold text-on-surface truncate">{thread?.senderAccount || '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-secondary">Thread ID</p>
                  <p className="text-xs font-semibold text-on-surface font-mono truncate">
                    {selectedMsg.gmail_thread_id ? `${selectedMsg.gmail_thread_id.slice(0, 10)}…` : '—'}
                  </p>
                </div>
              </div>
            </div>

            {/* Copy button */}
            <div className="border-t border-slate-100 px-5 py-3 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const firstMsg = thread?.messages[0];
                  const subject = firstMsg?.subject || '';
                  const body = firstMsg
                    ? (firstMsg.bodyType === 'html' ? firstMsg.body.replace(/<[^>]+>/g, '') : firstMsg.body)
                    : selectedMsg.reply_snippet || '';
                  navigator.clipboard?.writeText(`Subject: ${subject}\n\n${body}`);
                }}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold text-secondary border border-slate-200 rounded-lg py-2 hover:bg-surface-container transition-colors"
              >
                <span className="material-symbols-outlined text-[13px]">content_copy</span>
                Copy Message
              </button>
            </div>

          </div>
          </>
        )}
      </div>
    </div>
  );
}

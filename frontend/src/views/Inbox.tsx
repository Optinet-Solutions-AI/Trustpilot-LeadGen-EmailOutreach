'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import api from '../api/client';
import { useNotifications } from '../context/NotificationsContext';

type Folder = 'replies' | 'sent';

const FOLDERS: { key: Folder; icon: string; label: string }[] = [
  { key: 'replies', icon: 'reply',  label: 'Replies'    },
  { key: 'sent',    icon: 'send',   label: 'Sent Emails' },
];

type SenderAuthType = 'gmail_oauth' | 'app_password' | 'smtp' | 'unknown';

interface CampaignMessage {
  id: string;
  campaign_id: string;
  campaign_name: string;
  lead_id: string;
  company_name: string;
  country: string;
  email_used: string | null;
  sender_email: string | null;
  sender_auth_type: SenderAuthType;
  status: string;
  sent_at: string | null;
  replied_at: string | null;
  reply_read_at: string | null;
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
  rendered?: boolean;  // true = reconstructed from stored template, not live mailbox
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

function isSmtpAccount(authType: SenderAuthType): boolean {
  return authType === 'smtp';
}

function isGmailAccount(authType: SenderAuthType): boolean {
  return authType === 'gmail_oauth' || authType === 'app_password';
}

const STATUS_BADGE: Record<string, { label: string; classes: string }> = {
  replied:  { label: 'Replied',  classes: 'bg-[#8ff9a8]/30 text-[#006630]' },
  opened:   { label: 'Opened',   classes: 'bg-[#ffd9de]/60 text-[#b0004a]' },
  sent:     { label: 'Sent',     classes: 'bg-blue-50 text-blue-700' },
  bounced:  { label: 'Bounced',  classes: 'bg-red-50 text-error' },
  pending:  { label: 'Pending',  classes: 'bg-surface-container text-secondary' },
};

// Muted variant for replied-AND-read rows: the status stays accurate but the
// visual weight drops so the user can distinguish "new reply" from "already
// read reply" at a glance — without losing the status label entirely.
const REPLIED_READ_BADGE = { label: 'Replied', classes: 'bg-slate-100 text-slate-400' };

export default function Inbox() {
  const searchParams = useSearchParams();
  const openParam = searchParams?.get('open') ?? null;

  const [folder, setFolder] = useState<Folder>('replies');
  const [messages, setMessages] = useState<CampaignMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<CampaignMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkingMailbox, setCheckingMailbox] = useState(false);
  const [checkStatus, setCheckStatus] = useState<string | null>(null);
  const [expandedMsgIds, setExpandedMsgIds] = useState<Set<string>>(new Set());
  // Reply composer state — scoped to the currently-selected thread. Clears on
  // thread change or successful send.
  const [replyBody, setReplyBody] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [replyStatus, setReplyStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Gmail-style: only the latest message in a thread is expanded by default.
  // Earlier messages collapse to one-liners (avatar + name + snippet + date)
  // and expand on click. Resets whenever the thread changes.
  useEffect(() => {
    if (thread && thread.messages.length > 0) {
      const latest = thread.messages[thread.messages.length - 1];
      setExpandedMsgIds(new Set([latest.id]));
    } else {
      setExpandedMsgIds(new Set());
    }
  }, [thread]);

  const toggleMsgExpanded = useCallback((id: string) => {
    setExpandedMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Reset composer when thread changes — a stale draft for one lead must never
  // leak into another lead's compose pane. Pre-fill subject from the loaded
  // thread (first message's subject, prefixed with Re: if needed).
  useEffect(() => {
    setReplyBody('');
    setReplyStatus(null);
    if (thread && thread.messages.length > 0) {
      const s = thread.messages[0].subject || '';
      setReplySubject(/^re:\s/i.test(s) ? s : `Re: ${s}`);
    } else {
      setReplySubject('');
    }
  }, [thread]);

  const sendReply = useCallback(async () => {
    if (!selectedMsg || replySending) return;
    if (!replyBody.trim()) {
      setReplyStatus({ kind: 'err', text: 'Reply body is empty' });
      return;
    }
    setReplySending(true);
    setReplyStatus(null);
    try {
      const res = await api.post(`/inbox/reply/${selectedMsg.id}`, {
        body: replyBody,
        subject: replySubject || undefined,
      });
      const data = res?.data?.data ?? {};
      setReplyStatus({
        kind: 'ok',
        text: data.testMode
          ? `Sent in test mode to ${data.to}`
          : `Sent to ${data.to}`,
      });
      setReplyBody('');

      // Optimistically append the backend-returned synthetic message so the
      // user sees their reply in the thread instantly, even if the IMAP
      // Sent-folder append is still propagating.
      if (data.message) {
        setThread((prev) => {
          if (!prev) return prev;
          const merged = {
            ...prev,
            messages: [...prev.messages, data.message],
          };
          // Expand only the new message — collapses earlier ones Gmail-style.
          setExpandedMsgIds(new Set([data.message.id]));
          return merged;
        });
      }

      // Schedule a background refetch a few seconds later: by then IMAP will
      // have indexed the new Sent entry, and the authoritative thread
      // (deduped by Message-ID) will replace our optimistic copy.
      const gmail = selectedMsg.sender_auth_type === 'gmail_oauth' || selectedMsg.sender_auth_type === 'app_password';
      const primaryUrl = gmail && selectedMsg.gmail_thread_id
        ? `/inbox/thread/${selectedMsg.gmail_thread_id}`
        : selectedMsg.sender_auth_type === 'smtp' && selectedMsg.gmail_message_id
          ? `/inbox/thread-smtp/${selectedMsg.id}`
          : null;
      if (primaryUrl) {
        setTimeout(async () => {
          try {
            const refresh = await api.get(primaryUrl);
            if (refresh.data?.data) setThread(refresh.data.data);
          } catch { /* ignore — optimistic copy already shown */ }
        }, 3000);
      }
      setTimeout(() => setReplyStatus(null), 4000);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || (err instanceof Error ? err.message : 'Failed to send reply');
      setReplyStatus({ kind: 'err', text: msg });
    } finally {
      setReplySending(false);
    }
  }, [selectedMsg, replyBody, replySubject, replySending]);

  const { markRead, refresh: refreshNotifications, unreadCount } = useNotifications();

  // Draggable panel width
  const [panelWidth, setPanelWidth] = useState(480);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const deeplinkHandledRef = useRef<string | null>(null);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: panelWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientX - dragRef.current.startX;
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

  // Manual mailbox poll — hits /gmail/check-replies which runs the same
  // Gmail + IMAP scan the 10-min background job does, then refreshes the list
  // and top-bar notification badges.
  const checkMailbox = useCallback(async () => {
    if (checkingMailbox) return;
    setCheckingMailbox(true);
    setCheckStatus(null);
    try {
      const res = await api.post('/gmail/check-replies');
      const total = res?.data?.data?.totalReplies ?? 0;
      setCheckStatus(total > 0 ? `${total} new repl${total === 1 ? 'y' : 'ies'} found` : 'No new replies');
      fetchMessages();
      refreshNotifications();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || (err instanceof Error ? err.message : 'Failed to check mailbox');
      setCheckStatus(msg);
    } finally {
      setCheckingMailbox(false);
      setTimeout(() => setCheckStatus(null), 4000);
    }
  }, [checkingMailbox, fetchMessages, refreshNotifications]);

  const openMessage = useCallback(async (msg: CampaignMessage) => {
    if (selectedId === msg.id) return;
    setSelectedId(msg.id);
    setSelectedMsg(msg);
    setThread(null);
    setThreadError(null);

    // Mark as read locally AND in the DB so the badges update immediately.
    // The awaited markRead posts to mark-replies-read; refreshNotifications
    // forces a re-fetch of the sidebar + bell badge so the number drops even
    // if the optimistic update and the 30s poll disagree.
    if (msg.status === 'replied' && !msg.reply_read_at) {
      setMessages((prev) => prev.map((m) => m.id === msg.id ? { ...m, reply_read_at: new Date().toISOString() } : m));
      try {
        await markRead([msg.id]);
      } finally {
        refreshNotifications();
      }
    }

    const canTryGmail = isGmailAccount(msg.sender_auth_type) && !!msg.gmail_thread_id;
    const canTrySmtp = isSmtpAccount(msg.sender_auth_type) && !!msg.gmail_message_id;
    const primaryUrl = canTryGmail
      ? `/inbox/thread/${msg.gmail_thread_id}`
      : canTrySmtp
        ? `/inbox/thread-smtp/${msg.id}`
        : null;

    // Three-tier strategy:
    //   1. Primary — stored IDs (Gmail thread, SMTP Message-ID)
    //   2. Search — walk every connected mailbox for a matching conversation
    //   3. Rendered — reconstruct from the stored campaign template + lead data
    // (3) always succeeds for sends with an intact campaign + lead row, so the
    // user never sees "thread not available" for a campaign they actually ran.
    setThreadLoading(true);
    try {
      let data = null;
      if (primaryUrl) {
        try {
          const res = await api.get(primaryUrl);
          data = res.data.data;
        } catch { /* fall through */ }
      }
      if (!data) {
        try {
          const res = await api.get(`/inbox/search-thread/${msg.id}`);
          data = res.data.data;
        } catch { /* fall through to rendered */ }
      }
      if (!data) {
        try {
          const res = await api.get(`/inbox/rendered-send/${msg.id}`);
          data = res.data.data;
        } catch (err: unknown) {
          const errMsg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
            || (err instanceof Error ? err.message : 'Failed to load thread');
          setThreadError(errMsg);
        }
      }
      setThread(data);
    } finally {
      setThreadLoading(false);
    }
  }, [selectedId, markRead, refreshNotifications]);

  // Deeplink from TopBar notification click: ?open=<campaignLeadId>
  useEffect(() => {
    if (!openParam || loading || deeplinkHandledRef.current === openParam) return;
    // Deep-link always lands in the Replies folder, where the target lives
    if (folder !== 'replies') {
      setFolder('replies');
      return; // fetchMessages will re-run and we'll re-enter this effect
    }
    const match = messages.find((m) => m.id === openParam);
    if (match) {
      deeplinkHandledRef.current = openParam;
      openMessage(match);
    }
  }, [openParam, folder, messages, loading, openMessage]);

  // When the user switches folders or refreshes, pull notifications again so badges
  // mirror the current DB state.
  useEffect(() => { refreshNotifications(); }, [folder, refreshNotifications]);

  const repliesCount = messages.filter(m => m.status === 'replied').length;
  const unreadInList = messages.filter(m => m.status === 'replied' && !m.reply_read_at).length;

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
            // Replies folder badge always tracks UNREAD replies, never total
            // replied count. When viewing Replies folder we can compute it
            // from the current list (unreadInList), which gives optimistic
            // feedback as the user clicks through. When viewing any other
            // folder we fall back to the notifications context's server-
            // authoritative count so the badge reflects actual unread state
            // across the whole account.
            const badge = f.key === 'replies'
              ? (folder === 'replies' ? unreadInList : unreadCount)
              : 0;
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
          <p className="text-xs font-extrabold uppercase tracking-wider text-secondary truncate">
            {loading
              ? 'Loading…'
              : checkStatus
                ? checkStatus
                : `${messages.length} message${messages.length !== 1 ? 's' : ''}`}
          </p>
          <div className="flex items-center gap-1 flex-shrink-0">
            {folder === 'replies' && (
              <button
                onClick={checkMailbox}
                disabled={checkingMailbox || loading}
                className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-secondary hover:text-[#b0004a] border border-slate-200 hover:border-[#b0004a]/40 rounded-md px-2 py-1 transition-colors disabled:opacity-40"
                title="Poll Gmail + IMAP for new replies now (otherwise runs every 10 min in the background)"
              >
                <span className={`material-symbols-outlined text-[13px] ${checkingMailbox ? 'animate-spin' : ''}`}>
                  {checkingMailbox ? 'progress_activity' : 'cloud_sync'}
                </span>
                {checkingMailbox ? 'Checking…' : 'Check Mailbox'}
              </button>
            )}
            <button
              onClick={fetchMessages}
              disabled={loading}
              className="text-secondary hover:text-[#b0004a] transition-colors disabled:opacity-40 p-1"
              title="Refresh list"
            >
              <span className={`material-symbols-outlined text-[16px] ${loading ? 'animate-spin' : ''}`}>
                {loading ? 'progress_activity' : 'refresh'}
              </span>
            </button>
          </div>
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
              const isUnread = msg.status === 'replied' && !msg.reply_read_at;
              const badge = msg.status === 'replied' && !isUnread
                ? REPLIED_READ_BADGE
                : STATUS_BADGE[msg.status] || STATUS_BADGE.sent;
              return (
                <button
                  key={msg.id}
                  onClick={() => openMessage(msg)}
                  className={`w-full text-left px-4 py-3.5 border-b border-slate-100 transition-colors hover:bg-white ${
                    isSelected ? 'bg-white border-l-2 border-l-[#b0004a]' : isUnread ? 'bg-[#8ff9a8]/5' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      {isUnread && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#006630] flex-shrink-0" aria-label="Unread" />
                      )}
                      <span className={`text-sm truncate ${isUnread ? 'font-black text-on-surface' : 'font-bold text-on-surface'}`}>
                        {msg.company_name}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-400 flex-shrink-0 ml-1">{formatDate(msg.replied_at || msg.sent_at)}</span>
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
            <div className="flex flex-col bg-white overflow-y-auto h-full flex-shrink-0 border-l border-slate-100" style={{ width: panelWidth }}>

            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-sm font-extrabold text-on-surface truncate" style={{ fontFamily: 'Manrope, sans-serif' }}>
                  {thread ? `Thread (${thread.messages.length} message${thread.messages.length !== 1 ? 's' : ''})` : 'Message Detail'}
                </p>
                {thread?.rendered && (
                  <span
                    className="text-[9px] font-bold bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200 flex items-center gap-1 flex-shrink-0"
                    title="Reconstructed from the stored campaign template — not a live mailbox thread. Happens for test-mode sends and legacy rows without mailbox attribution."
                  >
                    <span className="material-symbols-outlined text-[11px]">auto_fix</span>
                    RECONSTRUCTED
                  </span>
                )}
              </div>
              <button onClick={() => { setSelectedId(null); setSelectedMsg(null); setThread(null); setThreadError(null); }} className="p-1.5 rounded-lg hover:bg-surface-container transition-colors">
                <span className="material-symbols-outlined text-[18px] text-secondary">close</span>
              </button>
            </div>

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

            <div className="flex-1">
              {threadLoading ? (
                <div className="flex items-center justify-center py-14 gap-2 text-secondary text-sm">
                  <span className="material-symbols-outlined text-[#b0004a] text-[20px] animate-spin">progress_activity</span>
                  Loading thread{isSmtpAccount(selectedMsg.sender_auth_type) ? ' from IMAP' : ''}…
                </div>
              ) : thread && thread.messages.length > 0 ? (
                <div>
                  {/* Subject shown once at the top of the thread */}
                  <div className="px-5 pt-4 pb-3 border-b border-slate-100">
                    <p className="text-sm font-bold text-on-surface leading-snug">
                      {thread.messages[0].subject}
                    </p>
                  </div>
                  {thread.messages.map((msg) => {
                    const { name: fromName, email: fromEmail } = parseDisplayName(msg.from);
                    const isExpanded = expandedMsgIds.has(msg.id);
                    const displayName = fromName || fromEmail;
                    const senderAccount = thread.senderAccount?.toLowerCase() || '';
                    const isOutgoing = senderAccount !== '' && fromEmail.toLowerCase() === senderAccount;
                    return (
                      <div key={msg.id} className="border-b border-slate-100 last:border-b-0">
                        <button
                          type="button"
                          onClick={() => toggleMsgExpanded(msg.id)}
                          className={`w-full flex items-center gap-2 px-5 py-3 text-left transition-colors ${
                            isExpanded ? 'bg-white' : 'bg-[#f8f9fa] hover:bg-slate-100'
                          }`}
                        >
                          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${
                            isOutgoing ? 'bg-blue-50 text-blue-700' : 'bg-[#ffd9de] text-[#b0004a]'
                          }`}>
                            {displayName.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <p className="text-xs font-bold text-on-surface truncate">
                                {isOutgoing ? 'me' : displayName}
                              </p>
                              {isOutgoing && (
                                <span className="text-[9px] text-slate-400 font-semibold truncate">&lt;{fromEmail}&gt;</span>
                              )}
                            </div>
                            {!isExpanded && (
                              <p className="text-[11px] text-secondary truncate mt-0.5">
                                {msg.snippet || '(no preview)'}
                              </p>
                            )}
                          </div>
                          <span className="text-[10px] text-slate-400 flex-shrink-0">
                            {new Date(msg.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                          </span>
                        </button>
                        {isExpanded && (
                          <div className="px-5 pb-4 bg-white">
                            {msg.body ? (
                              <div
                                className="email-body text-secondary text-xs overflow-auto"
                                style={{ maxHeight: '400px' }}
                                dangerouslySetInnerHTML={{ __html: msg.bodyType === 'html' ? msg.body : msg.body.replace(/\n/g, '<br>') }}
                              />
                            ) : (
                              <p className="text-xs text-secondary italic">{msg.snippet}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
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
                  {threadError ? (
                    <p className="text-xs text-error flex items-center gap-1">
                      <span className="material-symbols-outlined text-[13px]">error_outline</span>
                      {threadError}
                    </p>
                  ) : isSmtpAccount(selectedMsg.sender_auth_type) && !selectedMsg.gmail_message_id ? (
                    <p className="text-xs text-slate-400 flex items-center gap-1">
                      <span className="material-symbols-outlined text-[13px]">info</span>
                      No Message-ID recorded for this SMTP send — full thread unavailable.
                    </p>
                  ) : isGmailAccount(selectedMsg.sender_auth_type) && !selectedMsg.gmail_thread_id ? (
                    <p className="text-xs text-slate-400 flex items-center gap-1">
                      <span className="material-symbols-outlined text-[13px]">info</span>
                      Gmail thread ID was not recorded for this send.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-400 flex items-center gap-1">
                      <span className="material-symbols-outlined text-[13px]">info</span>
                      Full thread not available for this message.
                    </p>
                  )}
                </div>
              )}
            </div>

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
                  <p className="text-xs font-semibold text-on-surface truncate">
                    {thread?.senderAccount || selectedMsg.sender_email || '—'}
                    {isSmtpAccount(selectedMsg.sender_auth_type) && (
                      <span className="ml-1 text-[9px] font-bold text-slate-400 uppercase tracking-wider">SMTP</span>
                    )}
                    {isGmailAccount(selectedMsg.sender_auth_type) && (
                      <span className="ml-1 text-[9px] font-bold text-slate-400 uppercase tracking-wider">Gmail</span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-secondary">
                    {isSmtpAccount(selectedMsg.sender_auth_type) ? 'Message-ID' : 'Thread ID'}
                  </p>
                  <p className="text-xs font-semibold text-on-surface font-mono truncate">
                    {(() => {
                      const id = isSmtpAccount(selectedMsg.sender_auth_type)
                        ? selectedMsg.gmail_message_id
                        : selectedMsg.gmail_thread_id;
                      return id ? `${id.slice(0, 14)}…` : '—';
                    })()}
                  </p>
                </div>
              </div>
            </div>

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

            <div
              onMouseDown={onDragStart}
              className="w-1.5 flex-shrink-0 self-stretch cursor-col-resize bg-slate-100 hover:bg-[#b0004a]/30 active:bg-[#b0004a]/50 transition-colors"
              title="Drag to resize panel"
            />

            {/* Right-side reply composer. Fills the remaining space. Always
                visible when a thread is selected so follow-up haggling is
                one keystroke away. */}
            <div className="flex-1 flex flex-col bg-surface-container-lowest overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <p className="text-xs font-extrabold uppercase tracking-wider text-secondary">
                    Reply
                  </p>
                  <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                    to {selectedMsg.email_used || '(unknown recipient)'} · from {selectedMsg.sender_email || '(unknown sender)'}
                  </p>
                </div>
                {replyStatus && (
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${
                    replyStatus.kind === 'ok'
                      ? 'bg-[#8ff9a8]/30 text-[#006630]'
                      : 'bg-red-50 text-error'
                  }`}>
                    {replyStatus.text}
                  </span>
                )}
              </div>

              <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                <span className="text-[11px] font-bold text-secondary uppercase tracking-wider w-14 flex-shrink-0">Subject</span>
                <input
                  type="text"
                  value={replySubject}
                  onChange={(e) => setReplySubject(e.target.value)}
                  placeholder="Re: …"
                  className="flex-1 text-xs bg-transparent outline-none border-0 text-on-surface placeholder:text-slate-400"
                />
              </div>

              <textarea
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                placeholder="Write your reply…"
                disabled={replySending}
                className="flex-1 px-5 py-4 text-sm text-on-surface bg-transparent outline-none border-0 resize-none placeholder:text-slate-400 disabled:opacity-50"
                style={{ fontFamily: 'Arial, sans-serif', lineHeight: '1.5' }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    sendReply();
                  }
                }}
              />

              <div className="border-t border-slate-100 px-5 py-3 flex items-center justify-between gap-3">
                <p className="text-[10px] text-slate-400">
                  <span className="font-bold">⌘/Ctrl + Enter</span> to send
                </p>
                <button
                  type="button"
                  onClick={sendReply}
                  disabled={replySending || !replyBody.trim()}
                  className="flex items-center gap-1.5 text-xs font-extrabold text-white bg-[#b0004a] hover:bg-[#8a003a] rounded-lg px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className={`material-symbols-outlined text-[15px] ${replySending ? 'animate-spin' : ''}`}>
                    {replySending ? 'progress_activity' : 'send'}
                  </span>
                  {replySending ? 'Sending…' : 'Send Reply'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

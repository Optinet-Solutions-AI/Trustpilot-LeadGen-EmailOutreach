'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import api from '../api/client';
import { useNotifications } from '../context/NotificationsContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { translateText } from '../lib/translate';

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
  /** 'outreach' (default) or 'discovery_followup' — set in migration 028.
   *  Drives the campaign-type badge in the message list and the inbox filter. */
  campaign_type?: string;
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
  /** True when at least one non-dismissed discovered_contacts row exists for
   *  this campaign_lead — i.e. the user has already promoted this reply, or
   *  the auto-detector flagged it. Drives the green "Prospect" pill so the
   *  user can tell promoted-replies at a glance without losing them from the
   *  inbox. */
  is_prospect?: boolean;
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
  replied:      { label: 'Replied',      classes: 'bg-[#8ff9a8]/30 text-[#006630]' },
  auto_replied: { label: 'Auto-reply',   classes: 'bg-amber-50 text-amber-700' },
  opened:       { label: 'Opened',       classes: 'bg-[#ffd9de]/60 text-[#b0004a]' },
  sent:         { label: 'Sent',         classes: 'bg-blue-50 text-blue-700' },
  bounced:      { label: 'Bounced',      classes: 'bg-red-50 text-error' },
  pending:      { label: 'Pending',      classes: 'bg-surface-container text-secondary' },
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
  // Campaign-type filter — splits the inbox between cold outreach and the
  // discovery follow-up campaigns (added in migration 028). Persisted to
  // localStorage so the filter sticks across page refreshes.
  const [campaignTypeFilter, setCampaignTypeFilter] = useState<'all' | 'outreach' | 'discovery_followup'>(() => {
    if (typeof window === 'undefined') return 'all';
    const saved = localStorage.getItem('inbox_campaign_type_filter');
    return saved === 'outreach' || saved === 'discovery_followup' ? saved : 'all';
  });
  // Multi-select state for "Promote to Prospects". Scoped to the Replies
  // folder — selection clears when folder switches or messages refetch.
  const [selectedReplyIds, setSelectedReplyIds] = useState<Set<string>>(new Set());
  const [promoting, setPromoting] = useState(false);
  const [promoteResult, setPromoteResult] = useState<{ promoted: number; candidatesQueued: number; skipped: number } | null>(null);
  // Selection mode — entered via the "Promote to Prospects" button. When
  // active, clicking a reply toggles selection instead of opening the thread.
  // The user picks replies, then hits "Run" to execute, or "Cancel" to back
  // out. Outside selection mode the inbox behaves like a normal mail client.
  const [selectionMode, setSelectionMode] = useState(false);
  // Per-campaign filter — narrows the message list to a single campaign. The
  // dropdown is built from whatever campaigns have messages in the current
  // fetch, so it always reflects what's actually visible.
  const [campaignIdFilter, setCampaignIdFilter] = useState<string>('');
  // Sort order for the message list. 'latest' (default) sorts by sent/replied
  // timestamp desc; 'oldest' is the same axis ascending; 'alpha' sorts by
  // company name. Persisted so the choice sticks across refreshes.
  const [sortMode, setSortMode] = useState<'latest' | 'oldest' | 'alpha'>(() => {
    if (typeof window === 'undefined') return 'latest';
    const saved = localStorage.getItem('inbox_sort_mode');
    return saved === 'oldest' || saved === 'alpha' ? saved : 'latest';
  });
  // Free-text filter on company / campaign name.
  const [searchText, setSearchText] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const isMobile = useIsMobile();
  const [folderNavOpen, setFolderNavOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<CampaignMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkingMailbox, setCheckingMailbox] = useState(false);
  const [checkStatus, setCheckStatus] = useState<string | null>(null);
  const [expandedMsgIds, setExpandedMsgIds] = useState<Set<string>>(new Set());

  // Per-message Gemini translation cache. Keyed by ThreadMessage.id.
  //  `visible` toggles the body between original and translated; the cached
  //  text isn't refetched on toggle.
  interface TranslationEntry {
    status: 'loading' | 'done' | 'error';
    text?: string;
    sourceLanguage?: string;
    error?: string;
    visible: boolean;
  }
  const [translations, setTranslations] = useState<Record<string, TranslationEntry>>({});

  const handleTranslate = useCallback(async (msgId: string, body: string, bodyType: 'html' | 'plain') => {
    setTranslations((prev) => ({ ...prev, [msgId]: { status: 'loading', visible: true } }));
    try {
      const source = bodyType === 'plain' ? body.replace(/\n/g, '<br>') : body;
      const result = await translateText(source, 'English');
      setTranslations((prev) => ({
        ...prev,
        [msgId]: {
          status: 'done',
          text: result.text,
          sourceLanguage: result.sourceLanguage,
          visible: true,
        },
      }));
    } catch (e) {
      setTranslations((prev) => ({
        ...prev,
        [msgId]: {
          status: 'error',
          error: e instanceof Error ? e.message : 'Translation failed',
          visible: false,
        },
      }));
    }
  }, []);

  const toggleTranslationVisibility = useCallback((msgId: string) => {
    setTranslations((prev) => {
      const entry = prev[msgId];
      if (!entry || entry.status !== 'done') return prev;
      return { ...prev, [msgId]: { ...entry, visible: !entry.visible } };
    });
  }, []);
  // Which message in the thread the reply will thread under. Defaults to the
  // latest inbound message (matches the server's fallback), but the user can
  // click a different message to retarget. Null means "use server default".
  const [replyTargetMsgId, setReplyTargetMsgId] = useState<string | null>(null);
  // Reply composer state — scoped to the currently-selected thread. Clears on
  // thread change or successful send.
  const [replyBody, setReplyBody] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [replyStatus, setReplyStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Refs for logic that must not itself trigger re-renders or effect re-runs:
  //   - prevThreadIdRef distinguishes "user switched threads" (reset state)
  //     from "same thread refetched" (preserve the user's manual target).
  //   - userPinnedTargetRef flips true the first time the user clicks a
  //     message row. Without this, a new reply arriving mid-compose would
  //     silently steal the reply target and the user would send to the
  //     wrong message.
  const prevThreadIdRef = useRef<string | null>(null);
  const userPinnedTargetRef = useRef(false);

  // Thread-load + refetch handler. Two distinct behaviors:
  //   1. Thread switch (different threadId) — fresh state: expand latest,
  //      default target to latest inbound, clear the pin flag.
  //   2. Same-thread refetch (e.g. new reply arrived, optimistic append) —
  //      merge in the new latest without clobbering a user-pinned target.
  useEffect(() => {
    if (!thread || thread.messages.length === 0) {
      prevThreadIdRef.current = null;
      userPinnedTargetRef.current = false;
      setExpandedMsgIds(new Set());
      setReplyTargetMsgId(null);
      return;
    }

    const latest = thread.messages[thread.messages.length - 1];
    const senderAccount = thread.senderAccount?.toLowerCase() ?? '';
    const latestInbound = [...thread.messages].reverse().find((m) => {
      const fromEmail = (m.from.match(/<([^>]+)>/)?.[1] ?? m.from).toLowerCase();
      return senderAccount !== '' && fromEmail !== senderAccount;
    });
    const defaultTarget = (latestInbound ?? latest).id;

    const threadChanged = prevThreadIdRef.current !== thread.threadId;
    if (threadChanged) {
      prevThreadIdRef.current = thread.threadId;
      userPinnedTargetRef.current = false;
      setExpandedMsgIds(new Set([latest.id]));
      setReplyTargetMsgId(defaultTarget);
      return;
    }

    // Same thread refetched. Ensure the new latest is expanded (helps when a
    // just-arrived reply shows up) without collapsing rows the user opened.
    setExpandedMsgIds((prev) => {
      if (prev.has(latest.id)) return prev;
      const next = new Set(prev);
      next.add(latest.id);
      return next;
    });
    // Preserve the user's pinned target if it still exists in the refetched
    // thread; otherwise retarget to the new latest inbound.
    setReplyTargetMsgId((current) => {
      if (userPinnedTargetRef.current && current && thread.messages.some((m) => m.id === current)) {
        return current;
      }
      return defaultTarget;
    });
  }, [thread]);

  // Clicking a message row expands it AND pins it as the reply target.
  // The pin flag survives same-thread refetches so a new reply arriving
  // mid-compose can't silently redirect where the message will thread.
  const selectMsg = useCallback((id: string) => {
    userPinnedTargetRef.current = true;
    setReplyTargetMsgId(id);
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
        replyToMessageId: replyTargetMsgId || undefined,
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

      // Schedule a background refetch to replace our synthetic with the
      // authoritative IMAP copy — but only if the refetched thread actually
      // contains our new Message-ID. IMAP HEADER-References indexing can lag
      // 30-120s after append, so an eager replace would make the user's
      // freshly-sent reply vanish from the thread. If the refetch misses our
      // message, we merge: take the refetched messages and append our
      // synthetic so it stays visible.
      const gmail = selectedMsg.sender_auth_type === 'gmail_oauth' || selectedMsg.sender_auth_type === 'app_password';
      const primaryUrl = gmail && selectedMsg.gmail_thread_id
        ? `/inbox/thread/${selectedMsg.gmail_thread_id}`
        : selectedMsg.sender_auth_type === 'smtp' && selectedMsg.gmail_message_id
          ? `/inbox/thread-smtp/${selectedMsg.id}`
          : null;
      if (primaryUrl && data.message) {
        const syntheticMsg = data.message;
        setTimeout(async () => {
          try {
            const refresh = await api.get(primaryUrl);
            const refreshed = refresh.data?.data;
            if (!refreshed) return;
            const hasOurs = Array.isArray(refreshed.messages) &&
              refreshed.messages.some((m: { id?: string }) => m.id === syntheticMsg.id);
            if (hasOurs) {
              setThread(refreshed);
            } else {
              // IMAP hasn't indexed our reply yet — keep it in the thread so
              // the user doesn't see their message disappear. Dedupe against
              // anything refetched in case it shows up via a different id.
              setThread({
                ...refreshed,
                messages: [...refreshed.messages, syntheticMsg],
              });
            }
          } catch { /* ignore — synthetic remains in thread */ }
        }, 15000);
      }
      setTimeout(() => setReplyStatus(null), 4000);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || (err instanceof Error ? err.message : 'Failed to send reply');
      setReplyStatus({ kind: 'err', text: msg });
    } finally {
      setReplySending(false);
    }
  }, [selectedMsg, replyBody, replySubject, replySending, replyTargetMsgId]);

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
    setSelectedReplyIds(new Set());
    const params: Record<string, string> = { folder };
    if (campaignTypeFilter !== 'all') params.campaignType = campaignTypeFilter;
    api.get('/inbox/campaign-replies', { params })
      .then((res) => setMessages(res.data.data ?? []))
      .catch((err) => {
        setError(err?.response?.data?.error || err.message || 'Failed to load messages');
        setMessages([]);
      })
      .finally(() => setLoading(false));
  }, [folder, campaignTypeFilter]);

  const toggleReplySelected = useCallback((id: string) => {
    setSelectedReplyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Visible messages — the result of (campaign filter ∩ search ∩ sort) over
  // the raw `messages` returned by the API. Pulled out into a memo so the
  // list, the campaign dropdown, and the select-all checkbox all agree on
  // exactly which rows are currently in scope.
  const visibleMessages = useMemo(() => {
    let rows = messages;
    if (campaignIdFilter) rows = rows.filter((m) => m.campaign_id === campaignIdFilter);
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      rows = rows.filter((m) =>
        (m.company_name ?? '').toLowerCase().includes(q) ||
        (m.campaign_name ?? '').toLowerCase().includes(q) ||
        (m.email_used ?? '').toLowerCase().includes(q),
      );
    }
    const sorted = [...rows];
    if (sortMode === 'alpha') {
      sorted.sort((a, b) => (a.company_name ?? '').localeCompare(b.company_name ?? ''));
    } else {
      const dir = sortMode === 'latest' ? -1 : 1;
      sorted.sort((a, b) => {
        const at = a.replied_at || a.sent_at || '';
        const bt = b.replied_at || b.sent_at || '';
        if (at === bt) return 0;
        return at > bt ? dir : -dir;
      });
    }
    return sorted;
  }, [messages, campaignIdFilter, searchText, sortMode]);

  // Campaign list for the filter dropdown — distinct campaign_id/name pairs
  // appearing in the current fetch. Sorted by name so the dropdown is
  // predictable regardless of message arrival order.
  const campaignOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; type: string }>();
    for (const m of messages) {
      const existing = map.get(m.campaign_id);
      if (existing) existing.count++;
      else map.set(m.campaign_id, { id: m.campaign_id, name: m.campaign_name, count: 1, type: m.campaign_type ?? 'outreach' });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [messages]);

  // Bulk-select toggle — adds/removes every currently-visible reply from the
  // selection. We add to selection (rather than replace) so a campaign-by-
  // campaign workflow accumulates picks across filters.
  const allVisibleSelected = visibleMessages.length > 0 && visibleMessages.every((m) => selectedReplyIds.has(m.id));
  const toggleSelectAllVisible = useCallback(() => {
    setSelectedReplyIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const m of visibleMessages) next.delete(m.id);
      } else {
        for (const m of visibleMessages) next.add(m.id);
      }
      return next;
    });
  }, [allVisibleSelected, visibleMessages]);

  const promoteToProspects = useCallback(async () => {
    if (selectedReplyIds.size === 0 || promoting) return;
    setPromoting(true);
    setPromoteResult(null);
    try {
      const res = await api.post('/inbox/promote-to-prospects', {
        campaignLeadIds: [...selectedReplyIds],
      });
      const data = res.data?.data ?? {};
      const promoted = data.promoted ?? 0;
      const candidatesQueued = data.candidatesQueued ?? 0;
      const skipped = (data.results ?? []).filter((r: { status: string }) => r.status !== 'queued').length;
      setPromoteResult({ promoted, candidatesQueued, skipped });
      // Exit selection mode after a successful run — the picks are
      // consumed, so the inbox returns to its default "click to read" mode.
      setSelectionMode(false);
      fetchMessages();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setError(e?.response?.data?.error ?? e?.message ?? 'Failed to promote replies');
    } finally {
      setPromoting(false);
    }
  }, [selectedReplyIds, promoting, fetchMessages]);

  const enterSelectionMode = useCallback(() => {
    setSelectionMode(true);
    setSelectedId(null);  // close any currently-open thread
    setThread(null);
    setSelectedMsg(null);
  }, []);

  const cancelSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedReplyIds(new Set());
  }, []);

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
    <div className="flex h-full relative" style={{ height: 'calc(100vh - 3.5rem)' }}>
      {/* Mobile chrome: header with hamburger to open folder nav + back button when reading */}
      <div className="lg:hidden absolute top-0 inset-x-0 z-20 bg-white border-b border-slate-100 px-3 py-2 flex items-center gap-2 h-12">
        {selectedId ? (
          <>
            <button
              onClick={() => setSelectedId(null)}
              aria-label="Back to inbox"
              className="p-1.5 -ml-1.5 text-slate-600"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <p className="font-bold text-sm truncate flex-1">Message</p>
          </>
        ) : (
          <>
            <button
              onClick={() => setFolderNavOpen(true)}
              aria-label="Open folders"
              className="p-1.5 -ml-1.5 text-slate-600"
            >
              <span className="material-symbols-outlined">menu</span>
            </button>
            <p className="font-bold text-sm truncate flex-1">
              {FOLDERS.find((f) => f.key === folder)?.label ?? 'Inbox'}
            </p>
          </>
        )}
      </div>

      {/* Mobile folder backdrop */}
      {isMobile && folderNavOpen && (
        <div
          onClick={() => setFolderNavOpen(false)}
          className="lg:hidden fixed inset-0 bg-black/40 z-30"
          aria-hidden
        />
      )}

      {/* Left pane — folder nav */}
      <div
        data-open={folderNavOpen}
        className="w-64 border-r border-slate-100 bg-surface-container-lowest flex flex-col shrink-0 fixed lg:static inset-y-0 left-0 z-40 transition-transform duration-200 -translate-x-full data-[open=true]:translate-x-0 lg:translate-x-0 lg:data-[open=false]:translate-x-0"
      >
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
                onClick={() => { setFolder(f.key); setSelectionMode(false); setSelectedReplyIds(new Set()); setFolderNavOpen(false); }}
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

        {/* Filter bar — moved into the sidebar so it's persistent and out of
            the way of the message list. Each control narrows or sorts the
            visible messages without ever changing the underlying fetch. */}
        <div className="px-3 py-3 border-t border-slate-100 space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-secondary mb-1">Filters</p>
          <div className="relative">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-[15px]">search</span>
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search company, campaign, email..."
              className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-white rounded-lg border border-slate-200 focus:ring-2 focus:ring-[#b0004a]/20 focus:border-transparent focus:outline-none"
            />
          </div>
          <select
            value={campaignIdFilter}
            onChange={(e) => setCampaignIdFilter(e.target.value)}
            title="Filter by specific campaign"
            className="w-full text-xs bg-white border border-slate-200 rounded-lg px-2 py-1.5 focus:ring-2 focus:ring-[#b0004a]/20 focus:border-transparent focus:outline-none font-semibold"
          >
            <option value="">All campaigns ({campaignOptions.length})</option>
            {campaignOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.type === 'discovery_followup' ? ' [D-FU]' : ''} ({c.count})
              </option>
            ))}
          </select>
          <select
            value={sortMode}
            onChange={(e) => {
              const next = e.target.value as 'latest' | 'oldest' | 'alpha';
              setSortMode(next);
              if (typeof window !== 'undefined') localStorage.setItem('inbox_sort_mode', next);
            }}
            title="Sort the list"
            className="w-full text-xs bg-white border border-slate-200 rounded-lg px-2 py-1.5 focus:ring-2 focus:ring-[#b0004a]/20 focus:border-transparent focus:outline-none font-semibold"
          >
            <option value="latest">Latest first</option>
            <option value="oldest">Oldest first</option>
            <option value="alpha">Company A–Z</option>
          </select>
          <select
            value={campaignTypeFilter}
            onChange={(e) => {
              const next = e.target.value as 'all' | 'outreach' | 'discovery_followup';
              setCampaignTypeFilter(next);
              if (typeof window !== 'undefined') localStorage.setItem('inbox_campaign_type_filter', next);
            }}
            title="Filter by campaign type"
            className="w-full text-xs bg-white border border-slate-200 rounded-lg px-2 py-1.5 focus:ring-2 focus:ring-[#b0004a]/20 focus:border-transparent focus:outline-none font-semibold"
          >
            <option value="all">All types</option>
            <option value="outreach">Outreach campaigns only</option>
            <option value="discovery_followup">Discovery Follow-Up only</option>
          </select>
        </div>

        <div className="px-5 py-4 border-t border-slate-100 mt-auto">
          <p className="text-[10px] text-secondary leading-relaxed">
            Only showing emails related to your outreach campaigns. Click
            "Promote to Prospects" then pick replies to scrape.
          </p>
        </div>
      </div>

      {/* Center — message list */}
      <div className={`${selectedId ? 'hidden lg:flex' : 'flex'} flex-1 lg:flex-initial lg:w-96 border-r border-slate-100 flex-col bg-[#f8f9fa] shrink-0 overflow-hidden pt-12 lg:pt-0`}>
        <div className="px-4 py-3 border-b border-slate-100 bg-white flex items-center justify-between">
          <p className="text-xs font-extrabold uppercase tracking-wider text-secondary truncate">
            {loading
              ? 'Loading…'
              : checkStatus
                ? checkStatus
                : visibleMessages.length === messages.length
                  ? `${messages.length} message${messages.length !== 1 ? 's' : ''}`
                  : `${visibleMessages.length} of ${messages.length} message${messages.length !== 1 ? 's' : ''}`}
          </p>
          <div className="flex items-center gap-1 flex-shrink-0">
            {folder === 'replies' && !selectionMode && (
              <button
                onClick={enterSelectionMode}
                disabled={loading || visibleMessages.length === 0}
                className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-white bg-[#006630] hover:bg-[#005528] rounded-md px-2.5 py-1 transition-colors disabled:opacity-40"
                title="Enter selection mode — click replies to mark them, then Run to scrape & queue them on Prospects"
              >
                <span className="material-symbols-outlined text-[13px]">how_to_reg</span>
                Promote to Prospects
              </button>
            )}
            {folder === 'replies' && !selectionMode && (
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

        {/* Selection-mode bar — replaces normal "X messages" header when the
            user has clicked Promote to Prospects. Houses the Run / Cancel
            actions and the optional "Select all visible" toggle. */}
        {selectionMode && folder === 'replies' && (
          <div className="sticky top-0 z-10 px-4 py-3 border-b-2 border-[#006630]/30 bg-[#006630] text-white shadow-md flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px]">check_circle</span>
            <span className="text-xs font-bold flex-1">
              {selectedReplyIds.size === 0
                ? 'Click replies to select'
                : `${selectedReplyIds.size} reply${selectedReplyIds.size === 1 ? '' : 'ies'} selected`}
            </span>
            <button
              onClick={cancelSelectionMode}
              disabled={promoting}
              className="text-[10px] font-bold uppercase tracking-wider text-white/70 hover:text-white disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={promoteToProspects}
              disabled={promoting || selectedReplyIds.size === 0}
              className="flex items-center gap-1.5 text-xs font-bold text-[#006630] bg-white hover:bg-slate-50 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40"
              title="Scrape URL(s) in selected replies, surface candidates on Prospects, and pause cold sequences for these leads"
            >
              <span className={`material-symbols-outlined text-[15px] ${promoting ? 'animate-spin' : ''}`}>
                {promoting ? 'progress_activity' : 'play_arrow'}
              </span>
              {promoting ? 'Running…' : 'Run'}
            </button>
          </div>
        )}

        {/* Select-all-visible — convenience inside selection mode. */}
        {selectionMode && folder === 'replies' && visibleMessages.length > 0 && (
          <label
            className="flex items-center gap-2 px-4 py-2 border-b border-slate-100 bg-surface-container cursor-pointer hover:bg-surface-container-high transition-colors"
            title="Select every reply currently visible (respects the filters above)"
          >
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAllVisible}
              className="w-4 h-4 rounded border-slate-300 accent-[#006630] cursor-pointer"
            />
            <span className="text-[11px] font-bold uppercase tracking-wider text-secondary">
              {allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
            </span>
          </label>
        )}

        {promoteResult && (
          <div className="px-4 py-2 border-b border-slate-100 bg-blue-50 flex items-center gap-2">
            <span className="material-symbols-outlined text-[14px] text-blue-700">check_circle</span>
            <span className="text-[11px] font-semibold text-blue-800 flex-1">
              Promoted {promoteResult.promoted}, {promoteResult.candidatesQueued} candidate{promoteResult.candidatesQueued === 1 ? '' : 's'} queued{promoteResult.skipped > 0 ? ` (${promoteResult.skipped} skipped — no contacts in body)` : ''}.
            </span>
            <button
              onClick={() => setPromoteResult(null)}
              className="text-blue-700 hover:text-blue-900"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          </div>
        )}

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
            visibleMessages.map((msg) => {
              const isSelected = selectedId === msg.id;
              const isUnread = msg.status === 'replied' && !msg.reply_read_at;
              const badge = msg.status === 'replied' && !isUnread
                ? REPLIED_READ_BADGE
                : STATUS_BADGE[msg.status] || STATUS_BADGE.sent;
              const isPromoteSelected = selectedReplyIds.has(msg.id);
              const inSelectionMode = selectionMode && folder === 'replies';
              // Row click: in selection mode → toggle selection; otherwise →
              // open the thread for reading. This is the core "modal" UX
              // shift — the inbox has two distinct interaction modes.
              const handleRowActivate = () => {
                if (inSelectionMode) toggleReplySelected(msg.id);
                else openMessage(msg);
              };
              return (
                <div
                  key={msg.id}
                  role="button"
                  tabIndex={0}
                  onClick={handleRowActivate}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRowActivate(); } }}
                  className={`w-full text-left px-4 py-3.5 border-b border-slate-100 transition-colors hover:bg-white cursor-pointer border-l-4 ${
                    isPromoteSelected
                      ? 'bg-[#006630]/5 border-l-[#006630]'
                      : isSelected
                        ? 'bg-white border-l-[#b0004a]'
                        : isUnread
                          ? 'bg-[#8ff9a8]/5 border-l-transparent'
                          : 'border-l-transparent'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {inSelectionMode && (
                      <div className="flex items-center pt-0.5 flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={isPromoteSelected}
                          readOnly
                          tabIndex={-1}
                          className="w-4 h-4 rounded border-slate-300 accent-[#006630] pointer-events-none"
                        />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
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
                      <p className="text-xs text-secondary truncate mb-1.5 flex items-center gap-1.5">
                        {msg.campaign_type === 'discovery_followup' && (
                          <span
                            title="Discovery Follow-Up Campaign"
                            className="text-[9px] font-bold uppercase tracking-wide bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full whitespace-nowrap"
                          >
                            D-FU
                          </span>
                        )}
                        <span className="truncate">{msg.campaign_name}</span>
                      </p>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] text-slate-400 truncate">{msg.email_used || '—'}</span>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {msg.is_prospect && (
                            <span
                              className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#006630]/10 text-[#006630] inline-flex items-center gap-0.5"
                              title="Already promoted to Prospects — has at least one live discovered contact"
                            >
                              <span className="material-symbols-outlined text-[11px]">how_to_reg</span>
                              Prospect
                            </span>
                          )}
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badge.classes}`}>
                            {badge.label}
                          </span>
                        </div>
                      </div>
                      {msg.status === 'replied' && msg.reply_snippet && (
                        <p className="text-[11px] text-[#006630] truncate mt-1 italic">{msg.reply_snippet}</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right — thread / detail pane */}
      <div className={`${selectedId ? 'flex' : 'hidden lg:flex'} flex-col lg:flex-row flex-1 overflow-hidden lg:overflow-hidden bg-[#f8f9fa] pt-12 lg:pt-0`}>

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
            <div className="flex flex-col bg-white overflow-y-auto w-full lg:h-full lg:flex-shrink-0 lg:border-l border-slate-100" style={!isMobile ? { width: panelWidth } : undefined}>

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
                    const isReplyTarget = msg.id === replyTargetMsgId;
                    return (
                      <div key={msg.id} className={`border-b border-slate-100 last:border-b-0 ${
                        isReplyTarget ? 'border-l-[3px] border-l-[#b0004a]' : ''
                      }`}>
                        <button
                          type="button"
                          onClick={() => selectMsg(msg.id)}
                          title={isReplyTarget ? 'Reply will thread under this message' : 'Click to reply to this message'}
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
                              {isReplyTarget && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider text-[#b0004a] bg-[#ffd9de]/60 px-1.5 py-0.5 rounded">
                                  <span className="material-symbols-outlined text-[11px]">reply</span>
                                  Reply target
                                </span>
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
                              <>
                                {(() => {
                                  const t = translations[msg.id];
                                  const showTranslated = t?.status === 'done' && t.visible && t.text;
                                  const bodyHtml = showTranslated
                                    ? (t!.text as string)
                                    : msg.bodyType === 'html'
                                      ? msg.body
                                      : msg.body.replace(/\n/g, '<br>');
                                  return (
                                    <>
                                      <div
                                        className="email-body text-secondary text-xs overflow-auto"
                                        style={{ maxHeight: '400px' }}
                                        dangerouslySetInnerHTML={{ __html: bodyHtml }}
                                      />
                                      <div className="mt-2 flex items-center gap-2 text-[11px]">
                                        {t?.status === 'loading' && (
                                          <span className="inline-flex items-center gap-1 text-secondary">
                                            <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                                            Translating…
                                          </span>
                                        )}
                                        {t?.status === 'done' && (
                                          <>
                                            <button
                                              type="button"
                                              onClick={() => toggleTranslationVisibility(msg.id)}
                                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 text-secondary hover:bg-surface-container transition-colors font-semibold"
                                            >
                                              <span className="material-symbols-outlined text-[13px]">translate</span>
                                              {t.visible ? 'Show original' : 'Show translation'}
                                            </button>
                                            {t.sourceLanguage && t.sourceLanguage !== 'unknown' && (
                                              <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                                                {t.sourceLanguage} → en
                                              </span>
                                            )}
                                          </>
                                        )}
                                        {t?.status === 'error' && (
                                          <>
                                            <span className="text-error">{t.error || 'Translation failed'}</span>
                                            <button
                                              type="button"
                                              onClick={() => handleTranslate(msg.id, msg.body, msg.bodyType)}
                                              className="ml-1 underline text-secondary hover:text-on-surface"
                                            >
                                              Retry
                                            </button>
                                          </>
                                        )}
                                        {!t && (
                                          <button
                                            type="button"
                                            onClick={() => handleTranslate(msg.id, msg.body, msg.bodyType)}
                                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 text-secondary hover:bg-surface-container transition-colors font-semibold"
                                          >
                                            <span className="material-symbols-outlined text-[13px]">translate</span>
                                            Translate to English
                                          </button>
                                        )}
                                      </div>
                                    </>
                                  );
                                })()}
                              </>
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
              className="hidden lg:block w-1.5 flex-shrink-0 self-stretch cursor-col-resize bg-slate-100 hover:bg-[#b0004a]/30 active:bg-[#b0004a]/50 transition-colors"
              title="Drag to resize panel"
            />

            {/* Right-side reply composer. Fills the remaining space. Always
                visible when a thread is selected so follow-up haggling is
                one keystroke away. */}
            <div className="flex-1 flex flex-col bg-surface-container-lowest overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-extrabold uppercase tracking-wider text-secondary">
                    Reply
                  </p>
                  <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                    to {selectedMsg.email_used || '(unknown recipient)'} · from {selectedMsg.sender_email || '(unknown sender)'}
                  </p>
                  {(() => {
                    const targetMsg = thread?.messages.find((m) => m.id === replyTargetMsgId);
                    if (!targetMsg) return null;
                    const { name: tgtName, email: tgtEmail } = parseDisplayName(targetMsg.from);
                    const tgtLabel = tgtName || tgtEmail;
                    const tgtDate = new Date(targetMsg.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
                    return (
                      <p className="text-[11px] text-[#b0004a] mt-1 truncate flex items-center gap-1">
                        <span className="material-symbols-outlined text-[12px]">reply</span>
                        Threading under: <span className="font-semibold">{tgtLabel}</span> · {tgtDate}
                      </p>
                    );
                  })()}
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

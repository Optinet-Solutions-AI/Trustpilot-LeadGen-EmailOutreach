'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api from '../api/client';

type Folder = 'inbox' | 'sent' | 'spam';

const FOLDERS: { key: Folder; icon: string; label: string }[] = [
  { key: 'inbox', icon: 'inbox',                label: 'Inbox'   },
  { key: 'sent',  icon: 'send',                 label: 'Sent'    },
  { key: 'spam',  icon: 'report_gmailerrorred', label: 'Spam'    },
];

interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  labels: string[];
  senderAccount: string;
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

function parseDisplayName(address: string): { name: string; email: string } {
  const match = address.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { name: address, email: address };
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface AccountDiag {
  email: string | null;
  source: string;
  auth_type?: string;
  connected: boolean;
  issue: string | null;
}

export default function Inbox() {
  const router = useRouter();
  const [folder, setFolder] = useState<Folder>('inbox');
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [diagnostics, setDiagnostics] = useState<AccountDiag[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMessages = useCallback(() => {
    setLoading(true);
    setError(null);
    setSelectedThreadId(null);
    setThread(null);
    api.get('/inbox/messages', { params: { folder, limit: 50 } })
      .then((res) => {
        setMessages(res.data.data ?? []);
        const accs: string[] = res.data.accounts ?? [];
        setAccounts(accs);
        // If no accounts connected, fetch diagnostics to show why
        if (accs.length === 0) {
          api.get('/inbox/diagnostics').then(d => setDiagnostics(d.data.data ?? [])).catch(() => {});
        }
      })
      .catch((err) => {
        setError(err?.response?.data?.error || err.message || 'Failed to load messages');
        setMessages([]);
        api.get('/inbox/diagnostics').then(d => setDiagnostics(d.data.data ?? [])).catch(() => {});
      })
      .finally(() => setLoading(false));
  }, [folder]);

  useEffect(() => { fetchMessages(); }, [fetchMessages]);

  // Filtered messages by selected account
  const visibleMessages = accountFilter === 'all'
    ? messages
    : messages.filter(m => m.senderAccount === accountFilter);

  const openThread = async (msg: GmailMessage) => {
    if (selectedThreadId === msg.threadId) return;
    setSelectedThreadId(msg.threadId);
    setSelectedAccount(msg.senderAccount);
    setThread(null);
    setThreadLoading(true);

    try {
      const res = await api.get(`/inbox/thread/${msg.threadId}`, {
        params: { account: msg.senderAccount },
      });
      setThread(res.data.data);

      // Mark as read if unread
      if (msg.unread) {
        api.post('/inbox/mark-read', { messageId: msg.id, account: msg.senderAccount })
          .then(() => {
            setMessages(prev => prev.map(m =>
              m.id === msg.id ? { ...m, unread: false } : m
            ));
          })
          .catch(() => {});
      }
    } catch (err: any) {
      setThread(null);
    } finally {
      setThreadLoading(false);
    }
  };

  const unreadCount = messages.filter(m => m.unread).length;

  return (
    <div className="flex h-full" style={{ height: 'calc(100vh - 4rem)' }}>

      {/* Left pane — folder nav */}
      <div className="w-56 border-r border-slate-100 bg-surface-container-lowest flex flex-col shrink-0">
        <div className="px-5 py-6 border-b border-slate-100">
          <h2 className="text-lg font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>Inbox</h2>
          <p className="text-xs text-secondary mt-0.5">Connected Gmail</p>
        </div>

        <nav className="flex-1 px-2 py-4 space-y-0.5">
          {FOLDERS.map((f) => {
            const badge = f.key === 'inbox' ? unreadCount : 0;
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

        {/* Connected accounts */}
        <div className="px-5 py-4 border-t border-slate-100">
          <p className="text-[10px] font-extrabold uppercase tracking-wider text-secondary mb-2">Connected Accounts</p>
          {accounts.length === 0 ? (
            <div className="space-y-2">
              <button
                onClick={() => router.push('/email-accounts')}
                className="text-xs text-[#b0004a] font-semibold hover:underline flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-[14px]">add_circle</span>
                Connect Gmail OAuth
              </button>
              {/* Show diagnostic info for why accounts aren't connecting */}
              {diagnostics.filter(d => d.email).map((d, i) => (
                <div key={i} className="text-[10px] leading-tight">
                  <p className="font-semibold text-secondary truncate">{d.email}</p>
                  {d.issue && (
                    <p className="text-amber-600 mt-0.5 leading-snug">{d.issue}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-0.5">
              <button
                onClick={() => setAccountFilter('all')}
                className={`w-full text-left text-[11px] px-2 py-1 rounded-lg font-semibold transition-colors ${accountFilter === 'all' ? 'bg-[#ffd9de]/30 text-[#b0004a]' : 'text-secondary hover:bg-surface-container-high'}`}
              >
                All accounts
              </button>
              {accounts.map(acc => (
                <button
                  key={acc}
                  onClick={() => setAccountFilter(accountFilter === acc ? 'all' : acc)}
                  className={`w-full text-left flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors ${accountFilter === acc ? 'bg-[#ffd9de]/30 text-[#b0004a]' : 'text-secondary hover:bg-surface-container-high'}`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                  <span className="text-[11px] truncate">{acc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Center — message list */}
      <div className="w-80 border-r border-slate-100 flex flex-col bg-[#f8f9fa] shrink-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 bg-white flex items-center justify-between">
          <p className="text-xs font-extrabold uppercase tracking-wider text-secondary">
            {loading ? 'Loading…' : `${visibleMessages.length} message${visibleMessages.length !== 1 ? 's' : ''}${accountFilter !== 'all' ? ' · filtered' : ''}`}
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
              {accounts.length === 0 && (
                <button
                  onClick={() => router.push('/email-accounts')}
                  className="text-xs font-bold text-[#b0004a] hover:underline"
                >
                  Connect a Gmail account →
                </button>
              )}
            </div>
          ) : visibleMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <span className="material-symbols-outlined text-slate-300 text-[36px] mb-3">
                {folder === 'inbox' ? 'mark_email_unread' : folder === 'sent' ? 'send' : 'report_gmailerrorred'}
              </span>
              <p className="text-sm font-semibold text-secondary">
                {folder === 'inbox' ? 'Inbox is empty' : folder === 'sent' ? 'No sent emails' : 'No spam'}
              </p>
              {accounts.length === 0 && (
                <button
                  onClick={() => router.push('/email-accounts')}
                  className="mt-3 text-xs font-bold text-[#b0004a] hover:underline"
                >
                  Connect a Gmail account →
                </button>
              )}
            </div>
          ) : (
            visibleMessages.map((msg) => {
              const { name, email } = parseDisplayName(folder === 'sent' ? msg.to : msg.from);
              const isSelected = selectedThreadId === msg.threadId;
              return (
                <button
                  key={msg.id}
                  onClick={() => openThread(msg)}
                  className={`w-full text-left px-4 py-3.5 border-b border-slate-100 transition-colors hover:bg-white ${
                    isSelected ? 'bg-white border-l-2 border-l-[#b0004a]' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-sm truncate max-w-[160px] ${msg.unread ? 'font-bold text-on-surface' : 'font-medium text-secondary'}`}>
                      {name || email}
                    </span>
                    <span className="text-[10px] text-slate-400 flex-shrink-0 ml-1">{formatDate(msg.date)}</span>
                  </div>
                  <p className={`text-xs truncate mb-1 ${msg.unread ? 'font-semibold text-on-surface' : 'text-secondary'}`}>
                    {msg.subject || '(no subject)'}
                  </p>
                  <p className="text-[11px] text-slate-400 truncate leading-relaxed">{msg.snippet}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    {msg.unread && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#b0004a] flex-shrink-0" />
                    )}
                    <span className="text-[9px] text-slate-400 truncate">{msg.senderAccount}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right — thread / detail pane */}
      <div className="flex-1 flex flex-col bg-[#f8f9fa] overflow-hidden">
        {threadLoading ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-secondary text-sm">
            <span className="material-symbols-outlined text-[#b0004a] text-[20px] animate-spin">progress_activity</span>
            Loading thread…
          </div>
        ) : thread ? (
          <div className="flex flex-col h-full">
            {/* Thread header */}
            <div className="px-6 py-4 border-b border-slate-100 bg-white">
              <h3 className="text-base font-extrabold text-on-surface leading-tight" style={{ fontFamily: 'Manrope, sans-serif' }}>
                {thread.messages[0]?.subject || '(no subject)'}
              </h3>
              <p className="text-xs text-secondary mt-1">
                {thread.messages.length} message{thread.messages.length !== 1 ? 's' : ''} · account: {thread.senderAccount}
              </p>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {thread.messages.map((msg, idx) => {
                const { name: fromName, email: fromEmail } = parseDisplayName(msg.from);
                const isLast = idx === thread.messages.length - 1;
                return (
                  <div key={msg.id} className={`bg-white rounded-xl ambient-shadow overflow-hidden ${isLast ? 'ring-1 ring-[#b0004a]/10' : ''}`}>
                    {/* Message header */}
                    <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-full bg-[#ffd9de] flex items-center justify-center flex-shrink-0 text-[#b0004a] font-extrabold text-sm">
                          {(fromName || fromEmail).charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-on-surface truncate">{fromName || fromEmail}</p>
                          <p className="text-xs text-secondary truncate">{fromEmail !== fromName ? fromEmail : ''}</p>
                          <p className="text-xs text-slate-400 mt-0.5">To: {msg.to}</p>
                        </div>
                      </div>
                      <span className="text-xs text-slate-400 flex-shrink-0 mt-0.5">
                        {new Date(msg.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                      </span>
                    </div>

                    {/* Message body */}
                    <div className="px-5 py-4">
                      {msg.body ? (
                        msg.bodyType === 'html' ? (
                          <div
                            className="prose prose-sm max-w-none text-on-surface text-sm leading-relaxed overflow-auto"
                            style={{ maxHeight: '400px' }}
                            dangerouslySetInnerHTML={{ __html: msg.body }}
                          />
                        ) : (
                          <pre className="text-sm text-on-surface leading-relaxed whitespace-pre-wrap font-sans overflow-auto" style={{ maxHeight: '400px' }}>
                            {msg.body}
                          </pre>
                        )
                      ) : (
                        <p className="text-sm text-secondary italic">{msg.snippet}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
            <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-5">
              <span className="material-symbols-outlined text-[32px] text-secondary">mark_email_read</span>
            </div>
            <h3 className="text-xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {messages.length > 0 ? 'Select a message' : 'Your Gmail inbox'}
            </h3>
            <p className="text-sm text-secondary max-w-md leading-relaxed">
              {messages.length > 0
                ? 'Click any message to read the full conversation thread.'
                : accounts.length > 0
                  ? `Showing ${folder} for ${accounts.join(', ')}.`
                  : 'Connect a Gmail account to see your inbox here.'}
            </p>
            {accounts.length === 0 && !loading && (
              <button
                onClick={() => router.push('/email-accounts')}
                className="mt-5 flex items-center gap-2 px-5 py-2.5 primary-gradient text-on-primary rounded-lg text-sm font-bold ambient-shadow"
              >
                <span className="material-symbols-outlined text-[16px]">add_circle</span>
                Connect Gmail Account
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

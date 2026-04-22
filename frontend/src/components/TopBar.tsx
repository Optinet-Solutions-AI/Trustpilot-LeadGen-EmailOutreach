'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useNotifications } from '../context/NotificationsContext';

const HELP_ITEMS = [
  { icon: 'search',        label: 'Global Search',   desc: 'Type in the search bar → navigates to Lead Matrix with results' },
  { icon: 'language',      label: 'Enrich Leads',    desc: 'Select leads → click Enrich → scrapes website emails in the background (takes 2–5 min)' },
  { icon: 'verified_user', label: 'Verify Emails',   desc: 'Select leads → click Verify → checks deliverability via ZeroBounce' },
  { icon: 'send',          label: 'Send Campaign',   desc: 'Campaign Wizard → 5 steps → always run Test Flight before going live' },
  { icon: 'science',       label: 'Test Flight',     desc: 'Sends 1 email to your test address to confirm format/content before live send' },
  { icon: 'sync',          label: 'Stats Sync',      desc: 'Campaign stats (opens, replies, bounces) sync automatically every 2 minutes from Instantly' },
  { icon: 'hub',           label: 'Enrichment Flow', desc: 'Scrape → Enrich → Verify → Campaign → Test Flight → Live Send' },
];

function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function TopBar() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  const { unreadCount, items, loading, markRead, markAllRead } = useNotifications();

  // Close popovers on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setShowHelp(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setShowNotif(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSearch = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && query.trim()) {
      router.push(`/leads?search=${encodeURIComponent(query.trim())}`);
      setQuery('');
    }
  };

  const openReply = (id: string) => {
    markRead([id]);
    setShowNotif(false);
    router.push(`/inbox?open=${id}`);
  };

  return (
    <header className="fixed top-0 right-0 left-64 h-16 glass-panel border-b border-slate-100 z-40 flex justify-between items-center px-8">
      {/* Search */}
      <div className="relative w-80">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[18px]">
          search
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearch}
          placeholder="Search leads… press Enter"
          className="w-full bg-surface-container-low border-none rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#b0004a]/20 transition-all"
        />
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-5">

        {/* Notifications */}
        <div className="relative" ref={notifRef}>
          <button
            onClick={() => { setShowNotif(!showNotif); setShowHelp(false); }}
            className="relative text-slate-500 hover:text-[#b0004a] transition-colors"
            aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
          >
            <span className="material-symbols-outlined">notifications</span>
            {unreadCount > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 bg-[#b0004a] rounded-full border-2 border-white text-[9px] font-black text-white flex items-center justify-center leading-none"
                aria-hidden
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          {showNotif && (
            <div className="absolute right-0 top-10 w-80 bg-white rounded-xl ambient-shadow border border-slate-100 overflow-hidden z-50">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <p className="text-xs font-extrabold uppercase tracking-wider text-slate-500">
                  Notifications {unreadCount > 0 && <span className="text-[#b0004a]">· {unreadCount}</span>}
                </p>
                {unreadCount > 0 && (
                  <button
                    onClick={() => markAllRead()}
                    className="text-[10px] font-bold text-[#b0004a] hover:underline"
                  >
                    Mark all read
                  </button>
                )}
              </div>

              {loading && items.length === 0 ? (
                <div className="flex items-center justify-center py-10 gap-2 text-secondary text-sm">
                  <span className="material-symbols-outlined text-[#b0004a] text-[18px] animate-spin">progress_activity</span>
                  Loading…
                </div>
              ) : items.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <span className="material-symbols-outlined text-slate-300 text-[40px] block mb-2">notifications_none</span>
                  <p className="text-sm font-semibold text-secondary">All caught up</p>
                  <p className="text-xs text-slate-400 mt-1">New replies to your outreach appear here.</p>
                </div>
              ) : (
                <div className="max-h-96 overflow-y-auto divide-y divide-slate-50">
                  {items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => openReply(item.id)}
                      className="w-full text-left px-4 py-3 hover:bg-[#ffd9de]/10 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-[#8ff9a8]/30 flex items-center justify-center text-[#006630] flex-shrink-0 mt-0.5">
                          <span className="material-symbols-outlined text-[16px]">reply</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2 mb-0.5">
                            <p className="text-xs font-extrabold text-on-surface truncate">{item.company_name}</p>
                            <span className="text-[10px] text-slate-400 flex-shrink-0">{formatRelative(item.replied_at)}</span>
                          </div>
                          <p className="text-[10px] text-secondary mb-1 truncate">{item.campaign_name}</p>
                          {item.reply_snippet && (
                            <p className="text-[11px] text-[#006630] line-clamp-2 italic">{item.reply_snippet}</p>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              <div className="px-4 py-2 border-t border-slate-100 bg-surface-container-low">
                <button
                  onClick={() => { setShowNotif(false); router.push('/inbox'); }}
                  className="w-full text-xs font-bold text-[#b0004a] hover:underline py-1"
                >
                  Open Outreach Inbox →
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Help */}
        <div className="relative" ref={helpRef}>
          <button
            onClick={() => { setShowHelp(!showHelp); setShowNotif(false); }}
            className="text-slate-500 hover:text-[#b0004a] transition-colors"
          >
            <span className="material-symbols-outlined">help_outline</span>
          </button>

          {showHelp && (
            <div className="absolute right-0 top-10 w-96 bg-white rounded-xl ambient-shadow border border-slate-100 overflow-hidden z-50">
              <div className="px-5 py-4 border-b border-slate-100 bg-[#ffd9de]/20">
                <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>Quick Reference</p>
                <p className="text-xs text-secondary mt-0.5">How key features work</p>
              </div>
              <div className="divide-y divide-slate-50 max-h-96 overflow-y-auto">
                {HELP_ITEMS.map((item) => (
                  <div key={item.label} className="flex items-start gap-3 px-5 py-3">
                    <div className="w-7 h-7 rounded-lg bg-[#ffd9de]/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <span className="material-symbols-outlined text-[#b0004a] text-[15px]">{item.icon}</span>
                    </div>
                    <div>
                      <p className="text-xs font-bold text-on-surface">{item.label}</p>
                      <p className="text-xs text-secondary leading-relaxed mt-0.5">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 border-t border-slate-100 bg-surface-container-low">
                <p className="text-[10px] text-secondary">OptiRate — Test Phase · Powered by Instantly.ai + Supabase</p>
              </div>
            </div>
          )}
        </div>

        {/* Brand label only — no avatar */}
        <div className="pl-4 border-l border-slate-200">
          <p className="text-xs font-bold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>OptiRate</p>
          <p className="text-[10px] text-slate-500">Test Phase</p>
        </div>
      </div>
    </header>
  );
}

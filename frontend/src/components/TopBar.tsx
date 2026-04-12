'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const HELP_ITEMS = [
  { icon: 'search',        label: 'Global Search',   desc: 'Type in the search bar → navigates to Lead Matrix with results' },
  { icon: 'language',      label: 'Enrich Leads',    desc: 'Select leads → click Enrich → scrapes website emails in the background (takes 2–5 min)' },
  { icon: 'verified_user', label: 'Verify Emails',   desc: 'Select leads → click Verify → checks deliverability via ZeroBounce' },
  { icon: 'send',          label: 'Send Campaign',   desc: 'Campaign Wizard → 5 steps → always run Test Flight before going live' },
  { icon: 'science',       label: 'Test Flight',     desc: 'Sends 1 email to your test address to confirm format/content before live send' },
  { icon: 'sync',          label: 'Stats Sync',      desc: 'Campaign stats (opens, replies, bounces) sync automatically every 2 minutes from Instantly' },
  { icon: 'hub',           label: 'Enrichment Flow', desc: 'Scrape → Enrich → Verify → Campaign → Test Flight → Live Send' },
];

export default function TopBar() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

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
          >
            <span className="material-symbols-outlined">notifications</span>
            <span className="absolute top-0 right-0 w-2 h-2 bg-[#b0004a] rounded-full border-2 border-white" />
          </button>

          {showNotif && (
            <div className="absolute right-0 top-10 w-72 bg-white rounded-xl ambient-shadow border border-slate-100 overflow-hidden z-50">
              <div className="px-4 py-3 border-b border-slate-100">
                <p className="text-xs font-extrabold uppercase tracking-wider text-slate-500">Notifications</p>
              </div>
              <div className="px-4 py-8 text-center">
                <span className="material-symbols-outlined text-slate-300 text-[40px] block mb-2">notifications_none</span>
                <p className="text-sm font-semibold text-secondary">All caught up</p>
                <p className="text-xs text-slate-400 mt-1">Campaign alerts and reply notifications will appear here.</p>
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

'use client';

import { useState } from 'react';

export default function TopBar() {
  const [query, setQuery] = useState('');

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
          placeholder="Search leads, campaigns..."
          className="w-full bg-surface-container-low border-none rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#b0004a]/20 transition-all"
        />
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-5">
        {/* Notifications */}
        <button className="relative text-slate-500 hover:text-[#b0004a] transition-colors">
          <span className="material-symbols-outlined">notifications</span>
          <span className="absolute top-0 right-0 w-2 h-2 bg-[#b0004a] rounded-full border-2 border-white" />
        </button>

        {/* Help */}
        <button className="text-slate-500 hover:text-[#b0004a] transition-colors">
          <span className="material-symbols-outlined">help_outline</span>
        </button>

        {/* User */}
        <div className="flex items-center gap-3 pl-4 border-l border-slate-200">
          <div className="text-right">
            <p className="text-xs font-bold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
              OptiRate
            </p>
            <p className="text-[10px] text-slate-500">Test Phase</p>
          </div>
          <div className="w-9 h-9 rounded-full primary-gradient flex items-center justify-center text-white text-sm font-bold shadow-sm">
            OR
          </div>
        </div>
      </div>
    </header>
  );
}

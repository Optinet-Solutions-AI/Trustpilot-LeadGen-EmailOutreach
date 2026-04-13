'use client';

import { GEO_FILTERS, SORT_OPTIONS } from './AffiliateData';

interface DashboardToolbarProps {
  searchQuery: string;
  onSearchChange: (v: string) => void;
  geoFilter: string;
  onGeoFilterChange: (v: string) => void;
  sortBy: string;
  onSortChange: (v: string) => void;
}

export default function DashboardToolbar({
  searchQuery,
  onSearchChange,
  geoFilter,
  onGeoFilterChange,
  sortBy,
  onSortChange,
}: DashboardToolbarProps) {
  return (
    <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-5 flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[200px]">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[18px]">
          search
        </span>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by name, URL, or geo..."
          className="w-full bg-surface-container border border-outline-variant rounded-lg pl-10 pr-4 py-2.5 text-sm text-on-surface placeholder:text-slate-400 outline-none focus:border-[#b0004a] transition-colors"
        />
      </div>

      <div className="flex gap-2 flex-wrap">
        {GEO_FILTERS.map((g) => (
          <button
            key={g}
            onClick={() => onGeoFilterChange(g)}
            className={`rounded-lg px-4 py-2 text-sm font-bold transition-colors ${
              geoFilter === g
                ? 'bg-[#b0004a] text-white'
                : 'bg-surface-container text-secondary hover:bg-surface-container-high'
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      <select
        value={sortBy}
        onChange={(e) => onSortChange(e.target.value)}
        className="bg-surface-container border border-outline-variant rounded-lg px-3 py-2.5 text-sm text-on-surface outline-none cursor-pointer"
      >
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

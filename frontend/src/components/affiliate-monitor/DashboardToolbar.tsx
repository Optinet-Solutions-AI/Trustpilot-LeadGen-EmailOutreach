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
    <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-3 sm:p-5 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3">
      <div className="relative flex-1 sm:min-w-[200px]">
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

      <div className="flex gap-1.5 sm:gap-2 overflow-x-auto sm:flex-wrap -mx-1 sm:mx-0 px-1 sm:px-0 pb-1 sm:pb-0">
        {GEO_FILTERS.map((g) => (
          <button
            key={g}
            onClick={() => onGeoFilterChange(g)}
            className={`rounded-lg px-3 sm:px-4 py-2 text-xs sm:text-sm font-bold transition-colors flex-shrink-0 ${
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
        className="w-full sm:w-auto bg-surface-container border border-outline-variant rounded-lg px-3 py-2.5 text-sm text-on-surface outline-none cursor-pointer"
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

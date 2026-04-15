'use client';

import { Affiliate, COUNTRY_META } from './AffiliateData';

interface CountryOverviewProps {
  data: Affiliate[];
  onFilterClick: (geo: string) => void;
}

export default function CountryOverview({ data, onFilterClick }: CountryOverviewProps) {
  const counts: Record<string, number> = {};
  data.forEach((entry) => {
    entry.geo.forEach((g) => {
      counts[g] = (counts[g] || 0) + 1;
    });
  });

  const max = Math.max(...Object.values(counts), 1);

  const countries = Object.entries(COUNTRY_META)
    .filter(([code]) => counts[code])
    .map(([code, meta]) => ({ code, ...meta, count: counts[code] }));

  return (
    <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-8">
      <h3
        className="text-lg font-extrabold text-on-surface mb-5"
        style={{ fontFamily: 'Manrope, sans-serif' }}
      >
        Geographic Coverage
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {countries.map((c) => (
          <button
            key={c.code}
            onClick={() => {
              onFilterClick(c.code === 'Multiple' ? 'All' : c.code);
            }}
            className="bg-surface-container border border-outline-variant rounded-lg p-4 flex items-center gap-3 text-left hover:border-[#b0004a]/30 hover:bg-[#b0004a]/[0.03] transition-all cursor-pointer"
          >
            <span className="text-2xl">{c.flag}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-on-surface truncate">
                  {c.name}
                </span>
              </div>
              <span className="text-xs text-slate-400 font-mono">
                {c.count} page{c.count > 1 ? 's' : ''}
              </span>
              <div className="mt-1.5 h-1 bg-surface-container-high rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#b0004a] rounded-full transition-all"
                  style={{ width: `${Math.round((c.count / max) * 100)}%` }}
                />
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

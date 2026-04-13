'use client';

interface SummaryStatsProps {
  livePages: number;
  totalReviews: number;
  geoMarkets: number;
  avgRating: string;
}

const TILES: { key: keyof SummaryStatsProps; label: string; format: (v: number | string) => string }[] = [
  { key: 'livePages', label: 'Live TP Pages', format: (v) => String(v) },
  { key: 'totalReviews', label: 'Total Reviews', format: (v) => `${v}+` },
  { key: 'geoMarkets', label: 'Geo Markets', format: (v) => String(v) },
  { key: 'avgRating', label: 'Avg Rating', format: (v) => `${v}\u2605` },
];

export default function SummaryStats(props: SummaryStatsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {TILES.map((tile) => (
        <div
          key={tile.key}
          className="bg-surface-container-lowest rounded-xl ambient-shadow p-6 text-center"
        >
          <h4
            className="text-3xl font-black text-[#b0004a]"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            {tile.format(props[tile.key])}
          </h4>
          <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mt-2">
            {tile.label}
          </p>
        </div>
      ))}
    </div>
  );
}

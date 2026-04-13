'use client';

import { Fragment } from 'react';
import { AffiliateEntry, COUNTRY_META } from './AffiliateData';

interface AffiliateTableProps {
  data: AffiliateEntry[];
  expandedId: number | null;
  onToggleExpand: (id: number) => void;
  totalCount: number;
}

function StarRating({ rating }: { rating: number | null }) {
  if (rating == null) return <span className="text-xs text-slate-400 italic">N/A</span>;
  const full = Math.round(rating);
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={`material-symbols-outlined text-[16px] ${
              i <= full ? 'text-[#b0004a]' : 'text-slate-200'
            }`}
            style={{ fontVariationSettings: i <= full ? "'FILL' 1" : "'FILL' 0" }}
          >
            star
          </span>
        ))}
      </div>
      <span className="text-xs text-slate-400">{rating}</span>
    </div>
  );
}

function ReviewerFlag(reviewer: string) {
  if (reviewer.includes('AU')) return COUNTRY_META.AU.flag;
  if (reviewer.includes('DE')) return COUNTRY_META.DE.flag;
  if (reviewer.includes('IT')) return COUNTRY_META.IT.flag;
  if (reviewer.includes('DK')) return COUNTRY_META.DK.flag;
  if (reviewer.includes('CA')) return COUNTRY_META.CA.flag;
  if (reviewer.includes('GB')) return '\u{1F1EC}\u{1F1E7}';
  if (reviewer.includes('BR')) return '\u{1F1E7}\u{1F1F7}';
  if (reviewer.includes('NZ')) return '\u{1F1F3}\u{1F1FF}';
  if (reviewer.includes('AT')) return '\u{1F1E6}\u{1F1F9}';
  return COUNTRY_META.Multiple.flag;
}

function ExpandPanel({ entry }: { entry: AffiliateEntry }) {
  return (
    <div className="bg-slate-50/50 border-t border-slate-100 px-6 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Page Information */}
        <div>
          <h4 className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">
            Page Information
          </h4>
          <div className="space-y-0">
            {[
              { key: 'TP Page Title', val: entry.tp_title },
              { key: 'Trustpilot URL', val: entry.tp_url, link: `https://${entry.tp_url}` },
              { key: 'Website', val: entry.website, link: `https://${entry.website}` },
              { key: 'Total Reviews', val: entry.reviews != null ? String(entry.reviews) : 'N/A' },
              { key: 'Rating', val: entry.rating != null ? `${entry.rating} / 5` : 'N/A' },
              { key: 'Geo Markets', val: entry.geo.join(', ') },
              { key: 'Affiliate Name', val: entry.affiliate },
              { key: 'Owner', val: entry.owner },
            ].map((row) => (
              <div
                key={row.key}
                className="flex justify-between items-center py-2.5 border-b border-slate-100 last:border-b-0"
              >
                <span className="text-xs text-slate-400">{row.key}</span>
                {row.link ? (
                  <a
                    href={row.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-[#b0004a] hover:underline font-mono"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {row.val} &#8599;
                  </a>
                ) : (
                  <span className="text-xs font-medium text-on-surface text-right max-w-[250px]">
                    {row.val}
                  </span>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-3 leading-relaxed">{entry.description}</p>
          <a
            href={`https://${entry.tp_url}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-[#b0004a] text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="material-symbols-outlined text-[14px]">open_in_new</span>
            View on Trustpilot
          </a>
        </div>

        {/* Reviews */}
        <div>
          <h4 className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">
            Reviews
          </h4>
          <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
            {entry.reviews_text.map((rv, i) => (
              <div
                key={i}
                className="bg-white border border-slate-100 rounded-lg p-4"
              >
                <p className="text-sm text-on-surface leading-relaxed">
                  &ldquo;{rv.text}&rdquo;
                </p>
                <p className="text-xs text-slate-400 mt-2 font-mono">
                  <span className="mr-1.5">{ReviewerFlag(rv.reviewer)}</span>
                  {rv.reviewer}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AffiliateTable({
  data,
  expandedId,
  onToggleExpand,
  totalCount,
}: AffiliateTableProps) {
  return (
    <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50/50">
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3 w-12">
                #
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3">
                Page Name & URL
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3 hidden md:table-cell">
                Website
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3 whitespace-nowrap">
                Reviews
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3 hidden md:table-cell">
                Rating
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3">
                Geo
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3 w-10">
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {data.map((entry, idx) => (
              <Fragment key={entry.id}>
                <tr
                  onClick={() => onToggleExpand(entry.id)}
                  className={`cursor-pointer transition-colors hover:bg-[#b0004a]/[0.03] ${
                    entry.warning ? 'bg-red-50/50' : ''
                  } ${expandedId === entry.id ? 'bg-[#b0004a]/[0.05]' : ''}`}
                >
                  <td className="px-5 py-3.5 text-xs text-slate-400 font-mono">{idx + 1}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-on-surface text-sm">{entry.name}</span>
                      {entry.warning && (
                        <span className="px-2 py-0.5 bg-red-100 text-red-600 text-[10px] font-black rounded uppercase whitespace-nowrap">
                          FAKE DOMAIN
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 italic mt-0.5 truncate max-w-[300px]">
                      {entry.tp_title}
                    </p>
                    <a
                      href={`https://${entry.tp_url}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-[#b0004a] font-mono hover:underline mt-0.5 block"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {entry.tp_url}
                    </a>
                  </td>
                  <td className="px-5 py-3.5 hidden md:table-cell">
                    <a
                      href={`https://${entry.website}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[#b0004a] text-xs font-mono hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="material-symbols-outlined text-[12px]">link</span>
                      {entry.website}
                    </a>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-sm font-bold text-[#b0004a]">
                      {entry.reviews != null ? entry.reviews.toLocaleString() : '\u2014'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 hidden md:table-cell">
                    <StarRating rating={entry.rating} />
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex flex-wrap gap-1">
                      {entry.geo.map((g) => (
                        <span
                          key={g}
                          className="px-2 py-0.5 bg-[#ffd9de] text-[#b0004a] text-[10px] font-bold rounded"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400 text-lg">
                    <span
                      className={`material-symbols-outlined text-[18px] transition-transform ${
                        expandedId === entry.id ? 'rotate-180' : ''
                      }`}
                    >
                      expand_more
                    </span>
                  </td>
                </tr>
                {expandedId === entry.id && (
                  <tr>
                    <td colSpan={7} className="p-0">
                      <ExpandPanel entry={entry} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-6 py-4 bg-slate-50/50 border-t border-slate-100 flex justify-between text-xs text-slate-400">
        <span>Showing {data.length} of {totalCount} pages</span>
        <span>Click a row to see reviews</span>
      </div>
    </div>
  );
}

'use client';

import { Affiliate } from './AffiliateData';

interface PageChartTableProps {
  data: Affiliate[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: () => void;
  onDelete: (id: string) => void;
}

export default function PageChartTable({ data, selectedIds, onToggleSelect, onToggleAll, onDelete }: PageChartTableProps) {
  const allSelected = data.length > 0 && data.every((e) => selectedIds.has(e.id));
  const someSelected = data.some((e) => selectedIds.has(e.id));

  return (
    <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
      <div className="p-6 border-b border-slate-100">
        <h3
          className="text-xl font-extrabold text-on-surface"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Trustpilot <span className="text-[#b0004a]">Page</span> Chart
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          {data.length} affiliate pages &middot; TP page name &middot; description &middot; website link
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50/50">
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                  onChange={onToggleAll}
                  className="accent-[#b0004a] cursor-pointer w-4 h-4"
                />
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3 w-12">
                #
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3 min-w-[200px]">
                Name on Trustpilot
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3 hidden md:table-cell">
                Description
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3 whitespace-nowrap">
                Trustpilot Link
              </th>
              <th className="text-left text-[11px] font-bold uppercase tracking-widest text-slate-400 px-5 py-3 whitespace-nowrap">
                Website Link
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {data.map((entry, idx) => (
              <tr
                key={entry.id}
                className={`group transition-colors hover:bg-[#b0004a]/[0.03] ${
                  entry.warning ? 'bg-red-50/50' : ''
                } ${selectedIds.has(entry.id) ? 'bg-[#ffd9de]/30' : ''}`}
              >
                <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(entry.id)}
                    onChange={() => onToggleSelect(entry.id)}
                    className="accent-[#b0004a] cursor-pointer w-4 h-4"
                  />
                </td>
                <td className="px-5 py-3.5 text-xs text-slate-400 font-mono">
                  {idx + 1}
                </td>
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(entry.id); }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 shrink-0"
                      title="Delete"
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                    <span className="font-semibold text-on-surface text-sm">{entry.name}</span>
                    {entry.warning && (
                      <span className="px-2 py-0.5 bg-red-100 text-red-600 text-[10px] font-black rounded uppercase">
                        FAKE
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-5 py-3.5 text-sm text-slate-500 max-w-[400px] hidden md:table-cell">
                  {entry.description ?? '—'}
                </td>
                <td className="px-5 py-3.5">
                  {entry.tp_url ? (
                    <a
                      href={`https://${entry.tp_url}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[#b0004a] text-xs font-medium hover:underline"
                    >
                      <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                      Trustpilot
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td className="px-5 py-3.5">
                  {entry.website ? (
                    <a
                      href={`https://${entry.website}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[#b0004a] text-xs font-medium hover:underline font-mono"
                    >
                      <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                      {entry.website}
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

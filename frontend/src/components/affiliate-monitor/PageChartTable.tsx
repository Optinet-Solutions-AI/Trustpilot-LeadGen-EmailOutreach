'use client';

import { AffiliateEntry } from './AffiliateData';

interface PageChartTableProps {
  data: AffiliateEntry[];
}

export default function PageChartTable({ data }: PageChartTableProps) {
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
                className={`transition-colors hover:bg-[#b0004a]/[0.03] ${
                  entry.warning ? 'bg-red-50/50' : ''
                }`}
              >
                <td className="px-5 py-3.5 text-xs text-slate-400 font-mono">
                  {idx + 1}
                </td>
                <td className="px-5 py-3.5">
                  <span className="font-semibold text-on-surface text-sm">
                    {entry.name}
                  </span>
                  {entry.warning && (
                    <span className="ml-2 px-2 py-0.5 bg-red-100 text-red-600 text-[10px] font-black rounded uppercase">
                      FAKE
                    </span>
                  )}
                </td>
                <td className="px-5 py-3.5 text-sm text-slate-500 max-w-[400px] hidden md:table-cell">
                  {entry.description}
                </td>
                <td className="px-5 py-3.5">
                  <a
                    href={`https://${entry.tp_url}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[#b0004a] text-xs font-medium hover:underline"
                  >
                    <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                    Trustpilot
                  </a>
                </td>
                <td className="px-5 py-3.5">
                  <a
                    href={`https://${entry.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[#b0004a] text-xs font-medium hover:underline font-mono"
                  >
                    <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                    {entry.website}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

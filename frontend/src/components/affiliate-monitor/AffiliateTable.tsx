'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { Affiliate, COUNTRY_META } from './AffiliateData';

interface AffiliateTableProps {
  data: Affiliate[];
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  totalCount: number;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: () => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Omit<Affiliate, 'id' | 'created_at'>>) => Promise<Affiliate>;
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

function InlineNumberEdit({
  value,
  onSave,
  format,
  min,
  max,
  step,
  align = 'left',
  widthClass = 'w-20',
  display,
}: {
  value: number | null;
  onSave: (v: number | null) => Promise<void>;
  format: 'int' | 'float';
  min?: number;
  max?: number;
  step?: number;
  align?: 'left' | 'center' | 'right';
  widthClass?: string;
  display: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value));
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const begin = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(value == null ? '' : String(value));
    setEditing(true);
  };

  const commit = async () => {
    const trimmed = draft.trim();
    let next: number | null;
    if (trimmed === '') next = null;
    else if (format === 'int') next = parseInt(trimmed, 10);
    else next = parseFloat(trimmed);
    if (next != null && Number.isNaN(next)) { setEditing(false); return; }
    if (next === value) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // keep editing open so user can retry
    } finally {
      setSaving(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        onClick={(e) => e.stopPropagation()}
        disabled={saving}
        className={`${widthClass} border border-[#b0004a] rounded px-2 py-1 text-sm outline-none ${align === 'right' ? 'text-right' : ''}`}
      />
    );
  }
  return (
    <span
      onClick={begin}
      title="Click to edit"
      className="cursor-pointer hover:bg-[#b0004a]/10 rounded px-1 -mx-1 transition-colors inline-block"
    >
      {display}
    </span>
  );
}

function ExpandPanel({ entry }: { entry: Affiliate }) {
  return (
    <div className="bg-slate-50/50 border-t border-slate-100 px-6 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h4 className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">
            Page Information
          </h4>
          <div className="space-y-0">
            {[
              { key: 'Trustpilot URL', val: entry.tp_url, link: entry.tp_url ? `https://${entry.tp_url}` : null },
              { key: 'Website', val: entry.website, link: entry.website ? `https://${entry.website}` : null },
              { key: 'Total Reviews', val: entry.reviews != null ? String(entry.reviews) : 'N/A', link: null },
              { key: 'Rating', val: entry.rating != null ? `${entry.rating} / 5` : 'N/A', link: null },
              { key: 'Geo Markets', val: entry.geo.join(', ') || '—', link: null },
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
          {entry.description && (
            <p className="text-xs text-slate-500 mt-3 leading-relaxed">{entry.description}</p>
          )}
          {entry.tp_url && (
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
          )}
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
  selectedIds,
  onToggleSelect,
  onToggleAll,
  onDelete,
  onUpdate,
}: AffiliateTableProps) {
  const allSelected = data.length > 0 && data.every((e) => selectedIds.has(e.id));
  const someSelected = data.some((e) => selectedIds.has(e.id));

  return (
    <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
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
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
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
                  className={`group cursor-pointer transition-colors hover:bg-[#b0004a]/[0.03] ${
                    entry.warning ? 'bg-red-50/50' : ''
                  } ${expandedId === entry.id ? 'bg-[#b0004a]/[0.05]' : ''} ${
                    selectedIds.has(entry.id) ? 'bg-[#ffd9de]/30' : ''
                  }`}
                >
                  <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(entry.id)}
                      onChange={() => onToggleSelect(entry.id)}
                      className="accent-[#b0004a] cursor-pointer w-4 h-4"
                    />
                  </td>
                  <td className="px-5 py-3.5 text-xs text-slate-400 font-mono">{idx + 1}</td>
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
                        <span className="px-2 py-0.5 bg-red-100 text-red-600 text-[10px] font-black rounded uppercase whitespace-nowrap">
                          FAKE DOMAIN
                        </span>
                      )}
                    </div>
                    {entry.tp_url && (
                      <a
                        href={`https://${entry.tp_url}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-[#b0004a] font-mono hover:underline mt-0.5 block"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {entry.tp_url}
                      </a>
                    )}
                  </td>
                  <td className="px-5 py-3.5 hidden md:table-cell">
                    {entry.website ? (
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
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                    <InlineNumberEdit
                      value={entry.reviews}
                      format="int"
                      min={0}
                      widthClass="w-24"
                      display={
                        <span className="text-sm font-bold text-[#b0004a]">
                          {entry.reviews != null ? entry.reviews.toLocaleString() : '—'}
                        </span>
                      }
                      onSave={async (v) => { await onUpdate(entry.id, { reviews: v }); }}
                    />
                  </td>
                  <td className="px-5 py-3.5 hidden md:table-cell" onClick={(e) => e.stopPropagation()}>
                    <InlineNumberEdit
                      value={entry.rating}
                      format="float"
                      min={0}
                      max={5}
                      step={0.1}
                      widthClass="w-20"
                      display={<StarRating rating={entry.rating} />}
                      onSave={async (v) => { await onUpdate(entry.id, { rating: v }); }}
                    />
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
                    <td colSpan={8} className="p-0">
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
        <span>Click a row to see details</span>
      </div>
    </div>
  );
}

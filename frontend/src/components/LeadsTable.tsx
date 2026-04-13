import { useState, useRef } from 'react';
import type { Lead, LeadStatus } from '../types/lead';

interface Props {
  leads: Lead[];
  total: number;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onStatusChange: (id: string, status: LeadStatus) => void;
  onDelete: (id: string) => void;
  onSelect: (ids: string[]) => void;
  onLeadClick: (id: string) => void;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSortChange: (col: string) => void;
}

type ColKey = 'company' | 'country' | 'category' | 'email' | 'rating' | 'tags' | 'status';

const DEFAULT_COLS: ColKey[] = ['company', 'country', 'category', 'email', 'rating', 'tags', 'status'];
const COL_STORAGE_KEY = 'leads_col_order_v2';

const COL_LABELS: Record<ColKey, string> = {
  company: 'Company', country: 'Country', category: 'Category',
  email: 'Email', rating: 'Rating', tags: 'Tags', status: 'Status',
};

const COL_SORT_KEY: Partial<Record<ColKey, string>> = {
  company: 'company_name',
  category: 'category',
  email: 'primary_email',
  rating: 'star_rating',
  status: 'outreach_status',
};

const STATUSES: LeadStatus[] = ['new', 'contacted', 'replied', 'converted', 'lost'];

function loadColOrder(): ColKey[] {
  try {
    const stored = localStorage.getItem(COL_STORAGE_KEY);
    if (stored) {
      const parsed: ColKey[] = JSON.parse(stored);
      const valid = parsed.filter((c) => DEFAULT_COLS.includes(c));
      const missing = DEFAULT_COLS.filter((c) => !valid.includes(c));
      return [...valid, ...missing];
    }
  } catch {}
  return DEFAULT_COLS;
}

export default function LeadsTable({
  leads, total, page, totalPages,
  onPageChange, onStatusChange, onDelete, onSelect, onLeadClick,
  sortBy, sortDir, onSortChange,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [columns, setColumns] = useState<ColKey[]>(loadColOrder);
  const [dragOver, setDragOver] = useState<ColKey | null>(null);
  const dragCol = useRef<ColKey | null>(null);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
    onSelect([...next]);
  };
  const toggleAll = () => {
    if (selected.size === leads.length) {
      setSelected(new Set()); onSelect([]);
    } else {
      const all = new Set(leads.map((l) => l.id));
      setSelected(all); onSelect([...all]);
    }
  };

  const handleDragStart = (col: ColKey, e: React.DragEvent) => {
    dragCol.current = col;
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (col: ColKey, e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(col);
  };
  const handleDrop = (col: ColKey) => {
    const from = dragCol.current;
    if (!from || from === col) { setDragOver(null); return; }
    const next = [...columns];
    next.splice(next.indexOf(from), 1);
    next.splice(next.indexOf(col), 0, from);
    setColumns(next);
    localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(next));
    dragCol.current = null;
    setDragOver(null);
  };
  const handleDragEnd = () => { dragCol.current = null; setDragOver(null); };

  const renderHeader = (col: ColKey) => {
    const sortKey = COL_SORT_KEY[col];
    const active = sortKey && sortBy === sortKey;
    const isDragTarget = dragOver === col;

    return (
      <th
        key={col}
        draggable
        onDragStart={(e) => handleDragStart(col, e)}
        onDragOver={(e) => handleDragOver(col, e)}
        onDrop={() => handleDrop(col)}
        onDragEnd={handleDragEnd}
        className={`text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary select-none cursor-grab whitespace-nowrap ${isDragTarget ? 'bg-[#ffd9de]' : ''}`}
      >
        <span
          className={`inline-flex items-center gap-1 ${sortKey ? 'cursor-pointer hover:text-on-surface' : ''}`}
          onClick={sortKey ? () => onSortChange(sortKey) : undefined}
        >
          {COL_LABELS[col]}
          {sortKey && (
            <span className={`material-symbols-outlined text-[14px] ${active ? 'text-[#b0004a]' : 'text-slate-300'}`}>
              {active ? (sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
            </span>
          )}
        </span>
      </th>
    );
  };

  const renderCell = (col: ColKey, lead: Lead) => {
    switch (col) {
      case 'company':
        return (
          <td key={col} className="px-4 py-3 max-w-[220px]">
            {lead.trustpilot_url ? (
              <a
                href={lead.trustpilot_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="font-bold text-[#b0004a] hover:underline inline-flex items-center gap-1 text-sm leading-tight"
              >
                <span className="truncate max-w-[190px]">{lead.company_name}</span>
                <span className="material-symbols-outlined text-[12px] shrink-0">open_in_new</span>
              </a>
            ) : (
              <span className="font-bold text-on-surface text-sm">{lead.company_name}</span>
            )}
            {lead.website_url && (
              <a
                href={lead.website_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="block text-xs text-secondary hover:text-[#b0004a] truncate max-w-[200px] mt-0.5"
              >
                {lead.website_url.replace(/^https?:\/\//, '').slice(0, 30)}
              </a>
            )}
          </td>
        );
      case 'country':
        return <td key={col} className="px-4 py-3 text-sm text-secondary w-16">{lead.country || '—'}</td>;
      case 'category':
        return (
          <td key={col} className="px-4 py-3">
            {lead.category
              ? <span className="text-xs bg-surface-container text-secondary px-2.5 py-1 rounded-full font-semibold whitespace-nowrap">{lead.category.replace(/_/g, ' ')}</span>
              : <span className="text-slate-300 text-xs">—</span>}
          </td>
        );
      case 'email': {
        const hasWebsiteEmail = !!lead.website_email;
        const hasTpEmail = !!lead.trustpilot_email;
        const hasWebsiteUrl = !!lead.website_url;
        const neitherEmail = !hasWebsiteEmail && !hasTpEmail;

        // Enrichment status pill
        let enrichPill: React.ReactNode = null;
        if (hasWebsiteEmail) {
          enrichPill = (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-green-50 text-green-700 px-1.5 py-0.5 rounded-full">
              <span className="material-symbols-outlined text-[9px]">language</span>enriched
            </span>
          );
        } else if (hasWebsiteUrl && !hasWebsiteEmail) {
          enrichPill = (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full" title="Has website but no email found yet — run Enrich">
              <span className="material-symbols-outlined text-[9px]">hourglass_empty</span>not enriched
            </span>
          );
        } else if (!hasWebsiteUrl && hasTpEmail) {
          enrichPill = (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-full" title="No website URL found on Trustpilot">
              <span className="material-symbols-outlined text-[9px]">alternate_email</span>TP only
            </span>
          );
        } else if (!hasWebsiteUrl && !hasTpEmail) {
          enrichPill = (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-slate-100 text-slate-400 px-1.5 py-0.5 rounded-full">
              no email
            </span>
          );
        }

        return (
          <td key={col} className="px-4 py-3 min-w-[200px]">
            <div className="flex flex-col gap-1">
              {/* Website email row */}
              {hasWebsiteEmail ? (
                <span className="inline-flex items-center gap-1 text-xs text-on-surface">
                  <span className="material-symbols-outlined text-[12px] text-green-600 shrink-0" title="Website email">language</span>
                  <span className="truncate max-w-[160px] font-medium">{lead.website_email}</span>
                  {lead.email_verified && <span className="material-symbols-outlined text-[11px] text-[#006630] shrink-0">verified</span>}
                </span>
              ) : !neitherEmail && (
                <span className="inline-flex items-center gap-1 text-xs text-slate-300 italic">
                  <span className="material-symbols-outlined text-[12px] shrink-0">language</span>
                  <span>{hasWebsiteUrl ? 'no email found' : 'no website'}</span>
                </span>
              )}

              {/* Trustpilot email row */}
              {hasTpEmail ? (
                <span className="inline-flex items-center gap-1 text-xs text-secondary">
                  <span className="material-symbols-outlined text-[12px] text-blue-400 shrink-0" title="Trustpilot email">alternate_email</span>
                  <span className="truncate max-w-[160px]">{lead.trustpilot_email}</span>
                </span>
              ) : !neitherEmail && (
                <span className="inline-flex items-center gap-1 text-xs text-slate-300 italic">
                  <span className="material-symbols-outlined text-[12px] shrink-0">alternate_email</span>
                  <span>no TP email</span>
                </span>
              )}

              {/* Neither email */}
              {neitherEmail && <span className="text-slate-300 text-xs">—</span>}

              {/* Enrichment status pill */}
              <div>{enrichPill}</div>
            </div>
          </td>
        );
      }
      case 'rating':
        return (
          <td key={col} className="px-4 py-3 w-16">
            {lead.star_rating != null
              ? <span className="text-sm font-bold text-[#b0004a]">{lead.star_rating.toFixed(1)} ★</span>
              : <span className="text-slate-300 text-sm">—</span>}
          </td>
        );
      case 'tags':
        return (
          <td key={col} className="px-4 py-3">
            <div className="flex flex-wrap gap-1">
              {(lead.tags || []).map((tag) => (
                <span key={tag} className="text-xs bg-[#ffd9de] text-[#b0004a] px-2 py-0.5 rounded-full font-semibold">{tag}</span>
              ))}
            </div>
          </td>
        );
      case 'status':
        return (
          <td key={col} className="px-4 py-3 w-32" onClick={(e) => e.stopPropagation()}>
            <select
              value={lead.outreach_status}
              onChange={(e) => onStatusChange(lead.id, e.target.value as LeadStatus)}
              className="text-xs bg-surface-container rounded-lg px-2 py-1.5 border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none font-semibold w-full"
            >
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </td>
        );
      default:
        return null;
    }
  };

  return (
    <div className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-container border-b border-slate-100">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={selected.size === leads.length && leads.length > 0}
                  onChange={toggleAll}
                  className="rounded border-slate-300 w-3.5 h-3.5 accent-[#b0004a]"
                />
              </th>
              {columns.map(renderHeader)}
              <th className="w-12 px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {leads.map((lead) => (
              <tr
                key={lead.id}
                className="hover:bg-surface-container-low cursor-pointer transition-colors"
                onClick={() => onLeadClick(lead.id)}
              >
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(lead.id)}
                    onChange={() => toggleSelect(lead.id)}
                    className="rounded border-slate-300 w-3.5 h-3.5 accent-[#b0004a]"
                  />
                </td>
                {columns.map((col) => renderCell(col, lead))}
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => onDelete(lead.id)}
                    className="text-slate-300 hover:text-error p-1 rounded-lg hover:bg-red-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} className="p-12 text-center text-secondary">
                  <span className="material-symbols-outlined text-[32px] text-slate-200 block mb-2">search_off</span>
                  No leads found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 bg-surface-container">
          <span className="text-xs font-semibold text-secondary">{total} leads total</span>
          <div className="flex gap-1">
            {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                onClick={() => onPageChange(p)}
                className={`px-2.5 py-1 text-xs rounded-lg font-bold transition-colors ${
                  p === page
                    ? 'primary-gradient text-on-primary'
                    : 'bg-white border border-slate-200 text-secondary hover:bg-surface-container'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useRef } from 'react';
import { ExternalLink, Mail, Trash2, ShieldCheck, ShieldX, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
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

// undefined = not sortable
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
      // Ensure all default cols present, add missing ones at end
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
        className={`text-left px-2 py-2 font-medium text-gray-600 text-xs whitespace-nowrap select-none cursor-grab border-r border-gray-100 last:border-r-0 ${isDragTarget ? 'bg-blue-100' : ''}`}
      >
        <span
          className={`inline-flex items-center gap-0.5 ${sortKey ? 'cursor-pointer hover:text-gray-900' : ''}`}
          onClick={sortKey ? () => onSortChange(sortKey) : undefined}
        >
          {COL_LABELS[col]}
          {sortKey && (
            active
              ? sortDir === 'asc'
                ? <ChevronUp size={11} className="text-blue-500 shrink-0" />
                : <ChevronDown size={11} className="text-blue-500 shrink-0" />
              : <ChevronsUpDown size={11} className="text-gray-300 shrink-0" />
          )}
        </span>
      </th>
    );
  };

  const renderCell = (col: ColKey, lead: Lead) => {
    switch (col) {
      case 'company':
        return (
          <td key={col} className="px-2 py-1.5 max-w-[220px]">
            {lead.trustpilot_url ? (
              <a href={lead.trustpilot_url} target="_blank" rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="font-medium text-indigo-600 hover:text-indigo-800 hover:underline inline-flex items-center gap-0.5 text-xs leading-tight">
                <span className="truncate max-w-[190px]">{lead.company_name}</span>
                <ExternalLink size={9} className="shrink-0" />
              </a>
            ) : (
              <span className="font-medium text-gray-900 text-xs">{lead.company_name}</span>
            )}
            {lead.website_url && (
              <a href={lead.website_url} target="_blank" rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="block text-xs text-blue-400 hover:underline truncate max-w-[200px] mt-0.5">
                {lead.website_url.replace(/^https?:\/\//, '').slice(0, 30)}
              </a>
            )}
          </td>
        );
      case 'country':
        return <td key={col} className="px-2 py-1.5 text-xs text-gray-500 w-16">{lead.country || '-'}</td>;
      case 'category':
        return (
          <td key={col} className="px-2 py-1.5">
            {lead.category
              ? <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full whitespace-nowrap">{lead.category.replace(/_/g, ' ')}</span>
              : <span className="text-gray-300 text-xs">-</span>}
          </td>
        );
      case 'email':
        return (
          <td key={col} className="px-2 py-1.5">
            {lead.primary_email ? (
              <span className="inline-flex items-center gap-1 text-xs text-gray-700">
                <Mail size={11} className="shrink-0" />
                <span className="truncate max-w-[160px]">{lead.primary_email}</span>
                {lead.email_verified
                  ? <ShieldCheck size={11} className="text-green-500 shrink-0" />
                  : lead.verification_status === 'invalid'
                  ? <ShieldX size={11} className="text-red-400 shrink-0" />
                  : null}
              </span>
            ) : <span className="text-gray-300 text-xs">-</span>}
          </td>
        );
      case 'rating':
        return <td key={col} className="px-2 py-1.5 text-xs font-medium text-gray-700 w-14">{lead.star_rating != null ? lead.star_rating.toFixed(1) : '-'}</td>;
      case 'tags':
        return (
          <td key={col} className="px-2 py-1.5">
            <div className="flex flex-wrap gap-0.5">
              {(lead.tags || []).map((tag) => (
                <span key={tag} className="text-xs bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full">{tag}</span>
              ))}
            </div>
          </td>
        );
      case 'status':
        return (
          <td key={col} className="px-2 py-1.5 w-28" onClick={(e) => e.stopPropagation()}>
            <select value={lead.outreach_status}
              onChange={(e) => onStatusChange(lead.id, e.target.value as LeadStatus)}
              className="text-xs border border-gray-200 rounded px-1.5 py-0.5 w-full">
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </td>
        );
      default:
        return null;
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden text-left">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="w-7 px-2 py-2">
                <input type="checkbox" checked={selected.size === leads.length && leads.length > 0}
                  onChange={toggleAll} className="rounded border-gray-300 w-3 h-3" />
              </th>
              {columns.map(renderHeader)}
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {leads.map((lead) => (
              <tr key={lead.id} className="hover:bg-gray-50 cursor-pointer"
                onClick={() => onLeadClick(lead.id)}>
                <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(lead.id)}
                    onChange={() => toggleSelect(lead.id)} className="rounded border-gray-300 w-3 h-3" />
                </td>
                {columns.map((col) => renderCell(col, lead))}
                <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => onDelete(lead.id)}
                    className="text-gray-300 hover:text-red-500 p-0.5">
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr><td colSpan={columns.length + 2} className="p-8 text-center text-gray-400">No leads found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 bg-gray-50">
          <span className="text-xs text-gray-500">{total} leads total</span>
          <div className="flex gap-1">
            {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
              <button key={p} onClick={() => onPageChange(p)}
                className={`px-2 py-0.5 text-xs rounded ${p === page ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 hover:bg-gray-50'}`}>
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { ExternalLink, Mail, Trash2, ShieldCheck, ShieldX, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import StatusBadge from './StatusBadge';
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

const STATUSES: LeadStatus[] = ['new', 'contacted', 'replied', 'converted', 'lost'];

interface SortableHeaderProps {
  col: string;
  label: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSortChange: (col: string) => void;
  className?: string;
}

function SortableHeader({ col, label, sortBy, sortDir, onSortChange, className = '' }: SortableHeaderProps) {
  const active = sortBy === col;
  return (
    <th
      className={`text-left px-3 py-2.5 font-medium text-gray-600 cursor-pointer select-none hover:text-gray-900 whitespace-nowrap ${className}`}
      onClick={() => onSortChange(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          sortDir === 'asc' ? <ChevronUp size={13} className="text-blue-500" /> : <ChevronDown size={13} className="text-blue-500" />
        ) : (
          <ChevronsUpDown size={13} className="text-gray-300" />
        )}
      </span>
    </th>
  );
}

export default function LeadsTable({
  leads, total, page, totalPages,
  onPageChange, onStatusChange, onDelete, onSelect, onLeadClick,
  sortBy, sortDir, onSortChange,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
    onSelect([...next]);
  };

  const toggleAll = () => {
    if (selected.size === leads.length) {
      setSelected(new Set());
      onSelect([]);
    } else {
      const all = new Set(leads.map((l) => l.id));
      setSelected(all);
      onSelect([...all]);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="w-8 px-3 py-2.5">
                <input type="checkbox" checked={selected.size === leads.length && leads.length > 0}
                  onChange={toggleAll} className="rounded border-gray-300" />
              </th>
              <SortableHeader col="company_name" label="Company" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
              <SortableHeader col="country" label="Country" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} className="w-24" />
              <SortableHeader col="category" label="Category" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
              <SortableHeader col="primary_email" label="Email" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} />
              <SortableHeader col="star_rating" label="Rating" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} className="w-20" />
              <th className="text-left px-3 py-2.5 font-medium text-gray-600">Tags</th>
              <SortableHeader col="outreach_status" label="Status" sortBy={sortBy} sortDir={sortDir} onSortChange={onSortChange} className="w-32" />
              <th className="w-12 px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {leads.map((lead) => (
              <tr key={lead.id} className="hover:bg-gray-50 cursor-pointer"
                onClick={() => onLeadClick(lead.id)}>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(lead.id)}
                    onChange={() => toggleSelect(lead.id)} className="rounded border-gray-300" />
                </td>
                <td className="px-3 py-2">
                  {lead.trustpilot_url ? (
                    <a
                      href={lead.trustpilot_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium text-indigo-600 hover:text-indigo-800 hover:underline inline-flex items-center gap-1"
                    >
                      {lead.company_name}
                      <ExternalLink size={10} />
                    </a>
                  ) : (
                    <span className="font-medium text-gray-900">{lead.company_name}</span>
                  )}
                  {lead.website_url && (
                    <a href={lead.website_url} target="_blank" rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="block text-xs text-blue-400 hover:underline mt-0.5">
                      {lead.website_url.replace(/^https?:\/\//, '').slice(0, 28)}
                    </a>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-600 text-sm">{lead.country || '-'}</td>
                <td className="px-3 py-2">
                  {lead.category ? (
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                      {lead.category.replace(/_/g, ' ')}
                    </span>
                  ) : '-'}
                </td>
                <td className="px-3 py-2">
                  {lead.primary_email ? (
                    <span className="inline-flex items-center gap-1 text-gray-700">
                      <Mail size={12} />
                      <span>{lead.primary_email}</span>
                      {lead.email_verified ? (
                        <ShieldCheck size={12} className="text-green-500 shrink-0" />
                      ) : lead.verification_status === 'invalid' ? (
                        <ShieldX size={12} className="text-red-400 shrink-0" />
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {lead.star_rating !== null ? (
                    <span className="font-medium">{lead.star_rating.toFixed(1)}</span>
                  ) : '-'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(lead.tags || []).map((tag) => (
                      <span key={tag} className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">
                        {tag}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <select value={lead.outreach_status}
                    onChange={(e) => onStatusChange(lead.id, e.target.value as LeadStatus)}
                    className="text-xs border border-gray-200 rounded px-2 py-1">
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => onDelete(lead.id)}
                    className="text-gray-400 hover:text-red-500 p-1">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr><td colSpan={9} className="p-8 text-center text-gray-400">No leads found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
          <span className="text-sm text-gray-500">{total} leads total</span>
          <div className="flex gap-1">
            {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
              <button key={p} onClick={() => onPageChange(p)}
                className={`px-3 py-1 text-sm rounded ${p === page ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 hover:bg-gray-50'}`}>
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { ExternalLink, Mail, Phone, Trash2, ShieldCheck, ShieldX } from 'lucide-react';
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
}

const STATUSES: LeadStatus[] = ['new', 'contacted', 'replied', 'converted', 'lost'];

export default function LeadsTable({
  leads, total, page, totalPages,
  onPageChange, onStatusChange, onDelete, onSelect, onLeadClick,
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
              <th className="w-8 p-3">
                <input type="checkbox" checked={selected.size === leads.length && leads.length > 0}
                  onChange={toggleAll} className="rounded border-gray-300" />
              </th>
              <th className="text-left p-3 font-medium text-gray-600">Company</th>
              <th className="text-left p-3 font-medium text-gray-600">Country</th>
              <th className="text-left p-3 font-medium text-gray-600">Category</th>
              <th className="text-left p-3 font-medium text-gray-600">Email</th>
              <th className="text-left p-3 font-medium text-gray-600">Phone</th>
              <th className="text-left p-3 font-medium text-gray-600">Rating</th>
              <th className="text-left p-3 font-medium text-gray-600">Status</th>
              <th className="w-16 p-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {leads.map((lead) => (
              <tr key={lead.id} className="hover:bg-gray-50 cursor-pointer"
                onClick={() => onLeadClick(lead.id)}>
                <td className="p-3" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(lead.id)}
                    onChange={() => toggleSelect(lead.id)} className="rounded border-gray-300" />
                </td>
                <td className="p-3">
                  <div className="font-medium text-gray-900">{lead.company_name}</div>
                  {lead.website_url && (
                    <a href={lead.website_url} target="_blank" rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-blue-400 hover:underline inline-flex items-center gap-0.5">
                      {lead.website_url.replace(/^https?:\/\//, '').slice(0, 28)}
                      <ExternalLink size={9} />
                    </a>
                  )}
                </td>
                <td className="p-3 text-gray-600 text-sm">{lead.country || '-'}</td>
                <td className="p-3">
                  {lead.category ? (
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                      {lead.category.replace(/_/g, ' ')}
                    </span>
                  ) : '-'}
                </td>
                <td className="p-3">
                  {lead.primary_email ? (
                    <span className="inline-flex items-center gap-1 text-gray-700">
                      <Mail size={12} />
                      <span>{lead.primary_email}</span>
                      {lead.email_verified ? (
                        <ShieldCheck size={12} className="text-green-500 shrink-0" title="Email verified" />
                      ) : lead.verification_status === 'invalid' ? (
                        <ShieldX size={12} className="text-red-400 shrink-0" title="Email invalid" />
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="p-3">
                  {lead.phone ? (
                    <span className="inline-flex items-center gap-1 text-gray-700">
                      <Phone size={12} /> {lead.phone}
                    </span>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="p-3">
                  {lead.star_rating !== null ? (
                    <span className="font-medium">{lead.star_rating.toFixed(1)}</span>
                  ) : '-'}
                </td>
                <td className="p-3" onClick={(e) => e.stopPropagation()}>
                  <select value={lead.outreach_status}
                    onChange={(e) => onStatusChange(lead.id, e.target.value as LeadStatus)}
                    className="text-xs border border-gray-200 rounded px-2 py-1">
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td className="p-3" onClick={(e) => e.stopPropagation()}>
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

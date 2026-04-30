import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import api from '../../api/client';

interface PickerLead {
  id: string;
  company_name: string;
  primary_email: string | null;
  star_rating: number | null;
  outreach_status: string;
  verification_status: 'valid' | 'invalid' | 'catch-all' | 'unknown' | null;
}

interface Props {
  filterCountry: string;
  filterCategory: string;
  selectedLeadIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

const LIMIT = 50;
type SortDir = 'asc' | 'desc';

export default function StepRecipients({ filterCountry, filterCategory, selectedLeadIds, onSelectionChange }: Props) {
  const [leads, setLeads] = useState<PickerLead[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState('star_rating');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const toggleSort = (col: string) => {
    if (col === sortBy) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('asc'); }
    setPage(1);
  };

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterCountry) params.set('country', filterCountry);
      if (filterCategory) params.set('category', filterCategory);
      if (debouncedSearch) params.set('search', debouncedSearch);
      params.set('page', String(page));
      params.set('limit', String(LIMIT));
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);
      const res = await api.get(`/leads?${params}`);
      setLeads(res.data.data);
      setTotal(res.data.total);
      setTotalPages(res.data.totalPages);
    } catch {
      setLeads([]); setTotal(0); setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [filterCountry, filterCategory, debouncedSearch, page, sortBy, sortDir]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  // Block invalid leads from selection — mirrors the backend send-gate so
  // users can't queue up a campaign that the API will then refuse.
  const isInvalid = (l: PickerLead) => l.verification_status === 'invalid';
  const selectableLeads = leads.filter((l) => !isInvalid(l));

  const toggleLead = (id: string) => {
    const lead = leads.find((l) => l.id === id);
    if (lead && isInvalid(lead)) return;
    if (selectedLeadIds.includes(id)) onSelectionChange(selectedLeadIds.filter((x) => x !== id));
    else onSelectionChange([...selectedLeadIds, id]);
  };

  const pageIds = selectableLeads.map((l) => l.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedLeadIds.includes(id));

  const togglePage = () => {
    if (allPageSelected) onSelectionChange(selectedLeadIds.filter((id) => !pageIds.includes(id)));
    else onSelectionChange([...selectedLeadIds, ...pageIds.filter((id) => !selectedLeadIds.includes(id))]);
  };

  const SortIcon = ({ col }: { col: string }) => (
    <span className={`material-symbols-outlined text-[13px] ml-0.5 ${sortBy === col ? 'text-[#b0004a]' : 'text-slate-300'}`}>
      {sortBy === col ? (sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
    </span>
  );

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h3
            className="text-xl font-extrabold text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Select Recipients
          </h3>
          <p className="text-sm text-secondary mt-0.5">Choose which leads to include. Click headers to sort.</p>
        </div>
        {selectedLeadIds.length > 0 && (
          <div className="flex items-center gap-2 bg-[#ffd9de] rounded-xl px-3 py-2">
            <span className="material-symbols-outlined text-[#b0004a] text-[16px]">group</span>
            <span className="text-sm font-extrabold text-[#b0004a]" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {selectedLeadIds.length} selected
            </span>
          </div>
        )}
      </div>

      {/* Search + actions */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-secondary text-[18px]">search</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search companies..."
            className="w-full bg-surface-container rounded-xl pl-10 pr-4 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          {leads.length > 0 && (
            <button
              onClick={togglePage}
              className="text-xs font-bold text-[#b0004a] hover:text-[#7a0033] whitespace-nowrap bg-[#ffd9de] px-3 py-2 rounded-lg transition-colors"
            >
              {allPageSelected ? 'Deselect page' : 'Select page'}
            </button>
          )}
          {selectedLeadIds.length > 0 && (
            <button
              onClick={() => onSelectionChange([])}
              className="text-xs font-bold text-error hover:text-red-700 whitespace-nowrap bg-red-50 px-3 py-2 rounded-lg transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-secondary gap-2">
          <Loader2 size={16} className="animate-spin text-[#b0004a]" /> Loading leads...
        </div>
      ) : (
        <div className="bg-surface-container-lowest rounded-xl border border-slate-100 overflow-hidden ambient-shadow">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container border-b border-slate-100 text-left">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={togglePage}
                    className="rounded border-slate-300 w-3.5 h-3.5 accent-[#b0004a]"
                  />
                </th>
                <th
                  className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary cursor-pointer hover:text-on-surface select-none"
                  onClick={() => toggleSort('company_name')}
                >
                  Company <SortIcon col="company_name" />
                </th>
                <th
                  className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary cursor-pointer hover:text-on-surface select-none"
                  onClick={() => toggleSort('primary_email')}
                >
                  Email <SortIcon col="primary_email" />
                </th>
                <th
                  className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary cursor-pointer hover:text-on-surface select-none text-right w-20"
                  onClick={() => toggleSort('star_rating')}
                >
                  Rating <SortIcon col="star_rating" />
                </th>
                <th className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary w-24">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {leads.map((lead) => {
                const isSelected = selectedLeadIds.includes(lead.id);
                const blocked = isInvalid(lead);
                const isCatchAll = lead.verification_status === 'catch-all';
                const isUnknown = lead.verification_status === 'unknown';
                return (
                  <tr
                    key={lead.id}
                    className={`transition-colors ${
                      blocked
                        ? 'opacity-50 cursor-not-allowed bg-red-50/30'
                        : isSelected
                          ? 'bg-[#ffd9de]/30 hover:bg-[#ffd9de]/50 cursor-pointer'
                          : 'hover:bg-surface-container-low cursor-pointer'
                    }`}
                    onClick={() => !blocked && toggleLead(lead.id)}
                    title={blocked ? 'Blocked: verification_status=invalid (proven undeliverable). Re-verify or remove.' : undefined}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={blocked}
                        onChange={() => toggleLead(lead.id)}
                        className="rounded border-slate-300 w-3.5 h-3.5 accent-[#b0004a] disabled:cursor-not-allowed"
                      />
                    </td>
                    <td className="px-4 py-3 font-bold text-on-surface">{lead.company_name}</td>
                    <td className="px-4 py-3 text-xs">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-secondary ${blocked ? 'line-through text-slate-400' : ''}`}>
                          {lead.primary_email || <span className="text-slate-300">—</span>}
                        </span>
                        {blocked && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-red-50 text-red-700 px-1.5 py-0.5 rounded-full" title="Will bounce — excluded from sends">
                            <span className="material-symbols-outlined text-[9px]">cancel</span>invalid
                          </span>
                        )}
                        {isCatchAll && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full" title="Domain accepts all mail — individual mailbox can't be proven. Allowed but risky.">
                            <span className="material-symbols-outlined text-[9px]">help</span>catch-all
                          </span>
                        )}
                        {isUnknown && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-slate-50 text-slate-500 px-1.5 py-0.5 rounded-full" title="Not yet proven deliverable. Allowed but consider re-verifying.">
                            <span className="material-symbols-outlined text-[9px]">help_outline</span>unknown
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-[#b0004a] text-xs">
                      {lead.star_rating != null ? `${lead.star_rating} ★` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className="bg-surface-container text-secondary px-2 py-0.5 rounded-full font-semibold capitalize">
                        {lead.outreach_status}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {leads.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-secondary">
                    <span className="material-symbols-outlined text-[28px] text-slate-200 block mb-1">search_off</span>
                    No leads found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-secondary font-semibold">
            Showing {((page - 1) * LIMIT) + 1}–{Math.min(page * LIMIT, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
              className="p-2 rounded-lg bg-surface-container disabled:opacity-40 hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">chevron_left</span>
            </button>
            <span className="px-3 font-semibold text-secondary">Page {page} of {totalPages}</span>
            <button
              disabled={page === totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="p-2 rounded-lg bg-surface-container disabled:opacity-40 hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">chevron_right</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

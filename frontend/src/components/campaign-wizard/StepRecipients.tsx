import { useState, useEffect, useCallback } from 'react';
import { Search, Loader2, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import api from '../../api/client';

interface PickerLead {
  id: string;
  company_name: string;
  primary_email: string | null;
  star_rating: number | null;
  outreach_status: string;
}

interface Props {
  filterCountry: string;
  filterCategory: string;
  selectedLeadIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

const LIMIT = 50;
type SortDir = 'asc' | 'desc';

interface SortHeaderProps {
  label: string;
  col: string;
  sortBy: string;
  sortDir: SortDir;
  onSort: (col: string) => void;
  className?: string;
}

function SortHeader({ label, col, sortBy, sortDir, onSort, className = '' }: SortHeaderProps) {
  const active = sortBy === col;
  return (
    <th
      className={`px-3 py-2.5 font-medium cursor-pointer select-none hover:text-gray-900 whitespace-nowrap ${className}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {active
          ? sortDir === 'asc'
            ? <ChevronUp size={11} className="text-blue-500" />
            : <ChevronDown size={11} className="text-blue-500" />
          : <ChevronsUpDown size={11} className="text-gray-300" />}
      </span>
    </th>
  );
}

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
    if (col === sortBy) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
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

  const toggleLead = (id: string) => {
    if (selectedLeadIds.includes(id)) {
      onSelectionChange(selectedLeadIds.filter((x) => x !== id));
    } else {
      onSelectionChange([...selectedLeadIds, id]);
    }
  };

  const pageIds = leads.map((l) => l.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedLeadIds.includes(id));

  const togglePage = () => {
    if (allPageSelected) {
      onSelectionChange(selectedLeadIds.filter((id) => !pageIds.includes(id)));
    } else {
      const toAdd = pageIds.filter((id) => !selectedLeadIds.includes(id));
      onSelectionChange([...selectedLeadIds, ...toAdd]);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold mb-1">Select Recipients</h3>
        <p className="text-sm text-gray-500">Choose which leads to include. Click column headers to sort.</p>
      </div>

      {/* Search only */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search companies..."
            className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className={`font-medium ${selectedLeadIds.length > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
            {selectedLeadIds.length} selected
          </span>
          {leads.length > 0 && (
            <button onClick={togglePage} className="text-xs text-blue-500 hover:text-blue-700 whitespace-nowrap">
              {allPageSelected ? 'Deselect page' : 'Select page'}
            </button>
          )}
          {selectedLeadIds.length > 0 && (
            <button onClick={() => onSelectionChange([])} className="text-xs text-red-500 hover:text-red-700 whitespace-nowrap">
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-10 text-gray-400 gap-2">
          <Loader2 size={16} className="animate-spin" /> Loading leads...
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b text-left text-xs text-gray-500">
                <th className="w-8 px-3 py-2.5">
                  <input type="checkbox" checked={allPageSelected} onChange={togglePage}
                    className="rounded border-gray-300" />
                </th>
                <SortHeader label="Company" col="company_name" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Email" col="primary_email" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Rating" col="star_rating" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} className="w-20 text-right" />
                <th className="px-3 py-2.5 font-medium w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
                const isSelected = selectedLeadIds.includes(lead.id);
                return (
                  <tr key={lead.id}
                    className={`border-b last:border-b-0 cursor-pointer transition-colors ${isSelected ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-gray-50'}`}
                    onClick={() => toggleLead(lead.id)}
                  >
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={isSelected} onChange={() => toggleLead(lead.id)}
                        className="rounded border-gray-300" />
                    </td>
                    <td className="px-3 py-2 font-medium text-gray-800">{lead.company_name}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{lead.primary_email || <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{lead.star_rating != null ? `${lead.star_rating} ★` : '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-400">{lead.outreach_status}</td>
                  </tr>
                );
              })}
              {leads.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-10 text-center text-gray-400">No leads found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>Showing {((page - 1) * LIMIT) + 1}–{Math.min(page * LIMIT, total)} of {total}</span>
          <div className="flex items-center gap-1">
            <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}
              className="p-1 border rounded disabled:opacity-40 hover:bg-gray-50">
              <ChevronLeft size={13} />
            </button>
            <span className="px-2">Page {page} of {totalPages}</span>
            <button disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}
              className="p-1 border rounded disabled:opacity-40 hover:bg-gray-50">
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

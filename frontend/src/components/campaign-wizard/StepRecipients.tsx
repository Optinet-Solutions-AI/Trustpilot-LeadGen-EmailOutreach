import { useState, useEffect, useCallback } from 'react';
import { Search, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { COUNTRIES, CATEGORIES } from './StepSetup';
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

export default function StepRecipients({ filterCountry, filterCategory, selectedLeadIds, onSelectionChange }: Props) {
  const [leads, setLeads] = useState<PickerLead[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState(filterCountry);
  const [category, setCategory] = useState(filterCategory);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (country) params.set('country', country);
      if (category) params.set('category', category);
      if (debouncedSearch) params.set('search', debouncedSearch);
      params.set('page', String(page));
      params.set('limit', String(LIMIT));
      const res = await api.get(`/leads?${params}`);
      setLeads(res.data.data);
      setTotal(res.data.total);
      setTotalPages(res.data.totalPages);
    } catch {
      setLeads([]);
      setTotal(0);
      setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [country, category, debouncedSearch, page]);

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

  const clearAll = () => onSelectionChange([]);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold mb-1">Select Recipients</h3>
        <p className="text-sm text-gray-500">
          Choose which leads to include. Filters from Step 1 are pre-applied — adjust or search as needed.
        </p>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[150px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search companies..."
            className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <select
          value={country}
          onChange={(e) => { setCountry(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-2.5 py-2 text-sm"
        >
          {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
        <select
          value={category}
          onChange={(e) => { setCategory(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-2.5 py-2 text-sm"
        >
          {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </select>
      </div>

      {/* Selection count */}
      <div className="flex items-center justify-between">
        <span className={`text-sm font-medium ${selectedLeadIds.length > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
          {selectedLeadIds.length} lead{selectedLeadIds.length !== 1 ? 's' : ''} selected
        </span>
        <div className="flex items-center gap-3">
          {leads.length > 0 && (
            <button onClick={togglePage} className="text-xs text-blue-500 hover:text-blue-700">
              {allPageSelected ? 'Deselect page' : 'Select page'}
            </button>
          )}
          {selectedLeadIds.length > 0 && (
            <button onClick={clearAll} className="text-xs text-red-500 hover:text-red-700">
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
                <th className="px-3 py-2.5 font-medium">Company</th>
                <th className="px-3 py-2.5 font-medium">Email</th>
                <th className="px-3 py-2.5 font-medium text-right w-20">Rating</th>
                <th className="px-3 py-2.5 font-medium w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
                const isSelected = selectedLeadIds.includes(lead.id);
                return (
                  <tr
                    key={lead.id}
                    className={`border-b last:border-b-0 cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-gray-50'
                    }`}
                    onClick={() => toggleLead(lead.id)}
                  >
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleLead(lead.id)}
                        className="rounded border-gray-300"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium text-gray-800">{lead.company_name}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">
                      {lead.primary_email || <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {lead.star_rating != null ? `${lead.star_rating} ★` : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-400">{lead.outreach_status}</td>
                  </tr>
                );
              })}
              {leads.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-gray-400">
                    No leads found matching your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>
            Showing {((page - 1) * LIMIT) + 1}–{Math.min(page * LIMIT, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
              className="p-1 border rounded disabled:opacity-40 hover:bg-gray-50"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-2">Page {page} of {totalPages}</span>
            <button
              disabled={page === totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="p-1 border rounded disabled:opacity-40 hover:bg-gray-50"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

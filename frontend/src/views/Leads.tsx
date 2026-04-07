'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLeads } from '../hooks/useLeads';
import LeadsTable from '../components/LeadsTable';
import LeadPipeline from '../components/LeadPipeline';
import { LayoutList, Columns3, Search, ShieldCheck, Globe } from 'lucide-react';
import type { LeadStatus } from '../types/lead';
import api from '../api/client';

type View = 'table' | 'pipeline';

const COUNTRIES = [
  { code: '', name: 'All Countries' },
  { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' }, { code: 'CA', name: 'Canada' },
  { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' }, { code: 'DK', name: 'Denmark' },
  { code: 'SE', name: 'Sweden' }, { code: 'NO', name: 'Norway' },
  { code: 'FI', name: 'Finland' }, { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' }, { code: 'BR', name: 'Brazil' },
];

const CATEGORIES = [
  { slug: '', name: 'All Categories' },
  // Gambling
  { slug: 'gambling', name: 'Gambling (all)' },
  { slug: 'casino', name: 'Casino' },
  { slug: 'online_casino_or_bookmaker', name: 'Online Casino / Bookmaker' },
  { slug: 'online_sports_betting', name: 'Online Sports Betting' },
  { slug: 'betting_agency', name: 'Betting Agency' },
  { slug: 'bookmaker', name: 'Bookmaker' },
  { slug: 'gambling_service', name: 'Gambling Service' },
  { slug: 'gambling_house', name: 'Gambling House' },
  { slug: 'off_track_betting_shop', name: 'Off-Track Betting Shop' },
  { slug: 'lottery_vendor', name: 'Lottery Vendor' },
  { slug: 'online_lottery_ticket_vendor', name: 'Online Lottery Vendor' },
  { slug: 'lottery_retailer', name: 'Lottery Retailer' },
  { slug: 'lottery_shop', name: 'Lottery Shop' },
  { slug: 'gambling_instructor', name: 'Gambling Instructor' },
  // Gaming
  { slug: 'gaming', name: 'Gaming (all)' },
  { slug: 'gaming_service_provider', name: 'Gaming Service Provider' },
  { slug: 'bingo_hall', name: 'Bingo Hall' },
  { slug: 'video_game_store', name: 'Video Game Store' },
  { slug: 'game_store', name: 'Game Store' },
  // Finance
  { slug: 'bank', name: 'Bank' },
  { slug: 'insurance_agency', name: 'Insurance Agency' },
  { slug: 'money_transfer_service', name: 'Money Transfer' },
  // Other
  { slug: 'electronics_technology', name: 'Electronics & Technology' },
  { slug: 'travel_vacation', name: 'Travel & Vacation' },
];

export default function Leads() {
  const { leads, total, totalPages, loading, fetchLeads, updateLead, deleteLead } = useLeads();
  const router = useRouter();

  const [view, setView] = useState<View>(() => {
    // Guard against SSR — localStorage is only available in the browser
    if (typeof window === 'undefined') return 'table';
    return (localStorage.getItem('leads_view') as View) || 'table';
  });
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const loadLeads = useCallback(() => {
    const filters: Record<string, string | number> = { page, limit: view === 'pipeline' ? 200 : 25 };
    if (statusFilter) filters.status = statusFilter;
    if (countryFilter) filters.country = countryFilter;
    if (categoryFilter) filters.category = categoryFilter;
    if (search) filters.search = search;
    fetchLeads(filters as Parameters<typeof fetchLeads>[0]);
  }, [page, statusFilter, countryFilter, categoryFilter, search, view, fetchLeads]);

  useEffect(() => { loadLeads(); }, [loadLeads]);

  const handleViewChange = (v: View) => {
    setView(v);
    localStorage.setItem('leads_view', v);
  };

  const handleStatusChange = async (id: string, status: LeadStatus) => {
    await updateLead(id, { outreach_status: status });
  };

  const [verifying, setVerifying] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const notify = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  const handleBulkVerify = async () => {
    if (selectedIds.length === 0) return;
    setVerifying(true);
    try {
      const res = await api.post('/verify', { leadIds: selectedIds });
      const { verified, invalid, catchAll } = res.data.data;
      notify('success', `Verified ${selectedIds.length} leads — ${verified} valid, ${invalid} invalid, ${catchAll} catch-all`);
      loadLeads();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  const handleBulkEnrich = async () => {
    if (selectedIds.length === 0) return;
    setEnriching(true);
    try {
      const res = await api.post('/enrich', { leadIds: selectedIds });
      const { enriched, total } = res.data.data;
      notify('success', `Enriched ${total} leads — ${enriched} new emails found`);
      loadLeads();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Enrichment failed');
    } finally {
      setEnriching(false);
    }
  };

  return (
    <div className="space-y-4">
      {notification && (
        <div className={`px-4 py-3 rounded-md text-sm font-medium ${
          notification.type === 'success'
            ? 'bg-green-50 text-green-800 border border-green-200'
            : 'bg-red-50 text-red-800 border border-red-200'
        }`}>
          {notification.message}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Leads</h1>
        <div className="flex items-center gap-2">
          {selectedIds.length > 0 && (
            <>
              <button onClick={handleBulkEnrich} disabled={enriching || verifying}
                className="inline-flex items-center gap-1 bg-emerald-600 text-white px-3 py-1.5 rounded-md text-sm hover:bg-emerald-700 disabled:opacity-50">
                <Globe size={14} /> {enriching ? 'Enriching...' : `Enrich (${selectedIds.length})`}
              </button>
              <button onClick={handleBulkVerify} disabled={verifying || enriching}
                className="inline-flex items-center gap-1 bg-cyan-600 text-white px-3 py-1.5 rounded-md text-sm hover:bg-cyan-700 disabled:opacity-50">
                <ShieldCheck size={14} /> {verifying ? 'Verifying...' : `Verify (${selectedIds.length})`}
              </button>
            </>
          )}
          <div className="flex border border-gray-300 rounded-md overflow-hidden">
            <button onClick={() => handleViewChange('table')}
              className={`p-2 ${view === 'table' ? 'bg-gray-100' : 'bg-white hover:bg-gray-50'}`}>
              <LayoutList size={16} />
            </button>
            <button onClick={() => handleViewChange('pipeline')}
              className={`p-2 ${view === 'pipeline' ? 'bg-gray-100' : 'bg-white hover:bg-gray-50'}`}>
              <Columns3 size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search companies..."
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm" />
        </div>
        <select value={countryFilter} onChange={(e) => { setCountryFilter(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm">
          {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
        <select value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm">
          {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm">
          <option value="">All statuses</option>
          <option value="new">New</option>
          <option value="contacted">Contacted</option>
          <option value="replied">Replied</option>
          <option value="converted">Converted</option>
          <option value="lost">Lost</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">Loading leads...</div>
      ) : view === 'table' ? (
        <LeadsTable
          leads={leads} total={total} page={page} totalPages={totalPages}
          onPageChange={setPage}
          onStatusChange={handleStatusChange}
          onDelete={(id) => deleteLead(id)}
          onSelect={setSelectedIds}
          onLeadClick={(id) => router.push(`/leads/${id}`)}
        />
      ) : (
        <LeadPipeline
          leads={leads}
          onStatusChange={handleStatusChange}
          onLeadClick={(id) => router.push(`/leads/${id}`)}
        />
      )}
    </div>
  );
}

'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLeads } from '../hooks/useLeads';
import LeadsTable from '../components/LeadsTable';
import LeadPipeline from '../components/LeadPipeline';
import type { LeadStatus } from '../types/lead';
import api from '../api/client';
import QuickSendModal from '../components/QuickSendModal';

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
  { slug: 'gaming', name: 'Gaming (all)' },
  { slug: 'gaming_service_provider', name: 'Gaming Service Provider' },
  { slug: 'bingo_hall', name: 'Bingo Hall' },
  { slug: 'video_game_store', name: 'Video Game Store' },
  { slug: 'game_store', name: 'Game Store' },
  { slug: 'bank', name: 'Bank' },
  { slug: 'insurance_agency', name: 'Insurance Agency' },
  { slug: 'money_transfer_service', name: 'Money Transfer' },
  { slug: 'electronics_technology', name: 'Electronics & Technology' },
  { slug: 'travel_vacation', name: 'Travel & Vacation' },
];

export default function Leads() {
  const { leads, total, totalPages, loading, fetchLeads, updateLead, deleteLead } = useLeads();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [view, setView] = useState<View>(() => {
    if (typeof window === 'undefined') return 'table';
    return (localStorage.getItem('leads_view') as View) || 'table';
  });
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [hasEmailFilter, setHasEmailFilter] = useState(false);
  const [search, setSearch] = useState(() => searchParams?.get('search') ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState('scraped_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const toggleSort = (col: string) => {
    if (col === sortBy) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
    setPage(1);
  };

  const loadLeads = useCallback(() => {
    const filters: Record<string, string | number> = { page, limit: view === 'pipeline' ? 200 : 25 };
    if (statusFilter) filters.status = statusFilter;
    if (countryFilter) filters.country = countryFilter;
    if (categoryFilter) filters.category = categoryFilter;
    if (hasEmailFilter) (filters as any).hasEmail = 'true';
    if (search) filters.search = search;
    filters.sortBy = sortBy;
    filters.sortDir = sortDir;
    fetchLeads(filters as Parameters<typeof fetchLeads>[0]);
  }, [page, statusFilter, countryFilter, categoryFilter, hasEmailFilter, search, view, sortBy, sortDir, fetchLeads]);

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
  const [enrichJobId, setEnrichJobId] = useState<string | null>(() => localStorage.getItem('active_enrich_job'));
  const [enrichResult, setEnrichResult] = useState<{ found: number; total: number } | null>(null);
  const [quickSendOpen, setQuickSendOpen] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const notify = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
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

  const startEnrich = async (leadIds?: string[]) => {
    setEnriching(true);
    try {
      const body = leadIds && leadIds.length > 0 ? { leadIds } : {};
      const res = await api.post('/enrich', body);
      const { jobId, total: t } = res.data.data;
      if (!jobId) {
        notify('success', 'No leads needed enrichment (all already have website emails)');
        setEnriching(false);
        return;
      }
      notify('success', `Scraping websites for ${t} lead${t !== 1 ? 's' : ''} — results appear in a few minutes…`);
      localStorage.setItem('active_enrich_job', jobId);
      setEnrichJobId(jobId);
      setEnriching(true);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Enrichment failed');
      setEnriching(false);
    }
  };

  const handleBulkEnrich = () => startEnrich(selectedIds);
  const handleEnrichAll  = () => startEnrich();

  // Poll enrichment job status until done or failed.
  // enrichJobId is initialised from localStorage so this resumes after page refresh.
  useEffect(() => {
    if (!enrichJobId) return;
    setEnriching(true);

    let active = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    const finish = (success: boolean, result?: { found: number; total: number }, errMsg?: string) => {
      if (!active) return;
      active = false; // prevent any further polls immediately
      if (interval) clearInterval(interval);
      if (success && result) setEnrichResult(result);
      else if (errMsg) notify('error', errMsg);
      setEnriching(false);
      setEnrichJobId(null);
      localStorage.removeItem('active_enrich_job');
      loadLeads();
    };

    const poll = async () => {
      if (!active) return;
      try {
        const res = await api.get(`/enrich/status?jobId=${enrichJobId}`);
        const { status, found, total, error } = res.data.data;
        if (status === 'done') finish(true, { found, total });
        else if (status === 'failed') finish(false, undefined, `Enrichment failed: ${error || 'unknown error'}`);
        // 'running' → keep polling
      } catch (err: unknown) {
        const httpStatus = (err as { response?: { status?: number } })?.response?.status;
        if (httpStatus === 404) {
          // Stale job ID — clear it and reload the table (enrichment may have finished)
          if (!active) return;
          active = false;
          if (interval) clearInterval(interval);
          setEnriching(false);
          setEnrichJobId(null);
          localStorage.removeItem('active_enrich_job');
          loadLeads();
        }
        // Other network errors: keep polling
      }
    };

    // Check immediately on mount (don't wait 5s to detect stale IDs)
    poll();
    interval = setInterval(poll, 5000);
    return () => { active = false; if (interval) clearInterval(interval); };
  }, [enrichJobId]);

  return (
    <div className="px-10 py-10 space-y-8">

      {/* Enrichment running banner */}
      {enriching && enrichJobId && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-xl px-5 py-3 text-sm text-blue-800">
          <span className="material-symbols-outlined text-[18px] text-blue-500 animate-spin" style={{ animationDuration: '1.5s' }}>progress_activity</span>
          <span className="font-semibold">Website enrichment in progress</span>
          <span className="text-blue-600 font-normal">— visiting company websites to find contact emails. This can take several minutes.</span>
        </div>
      )}

      {/* Enrichment success banner — stays until dismissed */}
      {enrichResult && (
        <div className="flex items-center gap-3 bg-[#8ff9a8]/20 border border-[#006630]/20 rounded-xl px-5 py-3 text-sm text-[#006630]">
          <span className="material-symbols-outlined text-[18px] text-[#006630]">check_circle</span>
          <span className="font-semibold">Enrichment complete!</span>
          <span className="font-normal">
            Found <strong>{enrichResult.found}</strong> email{enrichResult.found !== 1 ? 's' : ''} out of <strong>{enrichResult.total}</strong> lead{enrichResult.total !== 1 ? 's' : ''}. The table has been refreshed.
          </span>
          <button
            onClick={() => setEnrichResult(null)}
            className="ml-auto text-[#006630]/60 hover:text-[#006630] transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h2
            className="text-4xl font-extrabold tracking-tight text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Lead <span className="text-[#b0004a]">Matrix</span>
          </h2>
          <p className="text-secondary font-medium mt-1">
            {total > 0 ? `${total} leads` : 'No leads yet'} — manage your outreach pipeline.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {selectedIds.length > 0 && (
            <>
              {/* Enrich */}
              <div className="relative group">
                <button
                  onClick={handleBulkEnrich}
                  disabled={enriching || verifying}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[#006630]/30 text-[#006630] text-sm font-bold hover:bg-[#006630]/5 disabled:opacity-50 transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px]">language</span>
                  {enriching ? 'Enriching...' : `Enrich (${selectedIds.length})`}
                </button>
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 bg-slate-800 text-white text-[11px] px-3 py-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 leading-relaxed text-center">
                  Visits each company website and scrapes their contact email. Runs in background — results appear in 2–5 min.
                  <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
                </div>
              </div>

              {/* Verify */}
              <div className="relative group">
                <button
                  onClick={handleBulkVerify}
                  disabled={verifying || enriching}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-blue-300 text-blue-700 text-sm font-bold hover:bg-blue-50 disabled:opacity-50 transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px]">verified_user</span>
                  {verifying ? 'Verifying...' : `Verify (${selectedIds.length})`}
                </button>
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 bg-slate-800 text-white text-[11px] px-3 py-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 leading-relaxed text-center">
                  Checks email deliverability via ZeroBounce. Marks each address as valid, invalid, or catch-all before sending.
                  <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
                </div>
              </div>

              {/* Send */}
              <div className="relative group">
                <button
                  onClick={() => setQuickSendOpen(true)}
                  disabled={verifying || enriching}
                  className="flex items-center gap-2 px-4 py-2 primary-gradient text-on-primary rounded-lg text-sm font-bold ambient-shadow hover:scale-[1.02] transition-transform disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[16px]">send</span>
                  Send ({selectedIds.length})
                </button>
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 bg-slate-800 text-white text-[11px] px-3 py-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 leading-relaxed text-center">
                  Send a quick one-off email to the selected leads without creating a full campaign.
                  <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
                </div>
              </div>
            </>
          )}
          {/* Enrich All — always visible, enriches every lead missing website_email */}
          <div className="relative group">
            <button
              onClick={handleEnrichAll}
              disabled={enriching}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[#006630]/30 text-[#006630] text-sm font-bold hover:bg-[#006630]/5 disabled:opacity-50 transition-colors"
            >
              <span className={`material-symbols-outlined text-[16px] ${enriching ? 'animate-spin' : ''}`}>
                {enriching ? 'progress_activity' : 'travel_explore'}
              </span>
              {enriching ? 'Enriching…' : 'Enrich All'}
            </button>
            <div className="absolute bottom-full mb-2 right-0 w-64 bg-slate-800 text-white text-[11px] px-3 py-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 leading-relaxed text-center">
              Visits every company website and finds their contact email. Only runs on leads that don't have a website email yet. Runs in background.
              <span className="absolute top-full right-4 border-4 border-transparent border-t-slate-800" />
            </div>
          </div>

          {/* View toggle */}
          <div className="flex bg-surface-container-high rounded-lg p-1 gap-1">
            <button
              onClick={() => handleViewChange('table')}
              className={`p-2 rounded-md transition-all ${view === 'table' ? 'bg-white ambient-shadow text-[#b0004a]' : 'text-secondary hover:text-on-surface'}`}
            >
              <span className="material-symbols-outlined text-[18px]">table_rows</span>
            </button>
            <button
              onClick={() => handleViewChange('pipeline')}
              className={`p-2 rounded-md transition-all ${view === 'pipeline' ? 'bg-white ambient-shadow text-[#b0004a]' : 'text-secondary hover:text-on-surface'}`}
            >
              <span className="material-symbols-outlined text-[18px]">view_kanban</span>
            </button>
          </div>
        </div>
      </div>

      {/* Notification */}
      {notification && (
        <div className={`px-4 py-3 rounded-xl text-sm font-medium border ${
          notification.type === 'success'
            ? 'bg-[#8ff9a8]/20 text-[#006630] border-[#006630]/20'
            : 'bg-[#ffd9de] text-[#b0004a] border-[#b0004a]/20'
        }`}>
          {notification.message}
        </div>
      )}

      {/* Filters */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-5">
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-secondary text-[18px]">search</span>
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search companies..."
              className="w-full pl-10 pr-3 py-2.5 bg-surface-container rounded-lg text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
            />
          </div>
          <select
            value={countryFilter}
            onChange={(e) => { setCountryFilter(e.target.value); setPage(1); }}
            className="bg-surface-container rounded-lg px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
          >
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
          <select
            value={categoryFilter}
            onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
            className="bg-surface-container rounded-lg px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
          >
            {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="bg-surface-container rounded-lg px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
          >
            <option value="">All statuses</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
            <option value="replied">Replied</option>
            <option value="converted">Converted</option>
            <option value="lost">Lost</option>
          </select>
          <button
            onClick={() => { setHasEmailFilter(v => !v); setPage(1); }}
            className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border transition-colors whitespace-nowrap ${
              hasEmailFilter
                ? 'bg-[#006630] text-white border-[#006630]'
                : 'bg-surface-container text-secondary border-transparent hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined text-[15px]">mail</span>
            Has Email
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48 gap-2 text-secondary">
            <span className="material-symbols-outlined text-[#b0004a] text-[20px]" style={{ animation: 'spin 1s linear infinite' }}>progress_activity</span>
            Loading leads...
          </div>
        ) : view === 'table' ? (
          <LeadsTable
            leads={leads}
            total={total}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            onStatusChange={handleStatusChange}
            onDelete={(id) => deleteLead(id)}
            onSelect={setSelectedIds}
            onLeadClick={(id) => router.push(`/leads/${id}`)}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={toggleSort}
          />
        ) : (
          <LeadPipeline
            leads={leads}
            onStatusChange={handleStatusChange}
            onLeadClick={(id) => router.push(`/leads/${id}`)}
          />
        )}
      </div>

      {quickSendOpen && (
        <QuickSendModal
          leadIds={selectedIds}
          leads={leads.filter((l) => selectedIds.includes(l.id))}
          onClose={() => setQuickSendOpen(false)}
          onDone={() => { setQuickSendOpen(false); loadLeads(); }}
        />
      )}
    </div>
  );
}

'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLeads } from '../hooks/useLeads';
import LeadsTable from '../components/LeadsTable';
import LeadPipeline from '../components/LeadPipeline';
import type { LeadStatus } from '../types/lead';
import api from '../api/client';
import QuickSendModal from '../components/QuickSendModal';
import JobProgress from '../components/JobProgress';
import { useEnrichJob } from '../hooks/useEnrichJob';
import { useVerifyJob } from '../hooks/useVerifyJob';
import { useCheckLinksJob } from '../hooks/useCheckLinksJob';
import { useCheckClaimedJob } from '../hooks/useCheckClaimedJob';

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
  const { leads, total, totalPages, loading, fetchLeads, updateLead, deleteLead, bulkDelete } = useLeads();
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
    // Hide leads whose websites redirect off-domain — those have their own
    // dedicated page (/redirected-leads) so the regular outreach pipeline
    // never accidentally pulls in misattributed leads.
    (filters as any).redirected = 'exclude';
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

  const [verifyJobId, setVerifyJobId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('active_verify_job');
  });
  const [verifyStartedAt, setVerifyStartedAt] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ total: number; verified: number; invalid: number; catchAll: number; unknown: number } | null>(null);
  const [verifyEmailField, setVerifyEmailField] = useState<'trustpilot' | 'website' | 'affiliate' | 'all'>('trustpilot');
  const [enrichJobId, setEnrichJobId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('active_enrich_job');
  });
  // Persisted alongside the jobId so a page refresh doesn't lose the elapsed
  // timer in the live progress widget. Cleared together with the jobId on
  // completion / failure / manual clear.
  const [enrichStartedAt, setEnrichStartedAt] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('active_enrich_started_at');
  });
  const [enrichResult, setEnrichResult] = useState<{ found: number; total: number; failed: number } | null>(null);
  const [quickSendOpen, setQuickSendOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const verifyJob = useVerifyJob(verifyJobId);
  const verifying = verifyJob.status === 'running';
  const enrichJob = useEnrichJob(enrichJobId);
  const enriching = enrichJob.status === 'running';

  const notify = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  const handleBulkVerify = async () => {
    if (selectedIds.length === 0) return;
    try {
      const res = await api.post('/verify', { leadIds: selectedIds, emailField: verifyEmailField });
      const { jobId, total, message, skippedValid } = res.data.data;
      if (!jobId) {
        notify('success', message || 'No leads needed verification');
        return;
      }
      const skipNote = skippedValid > 0
        ? ` (skipped ${skippedValid} already-valid lead${skippedValid === 1 ? '' : 's'})`
        : '';
      notify('success', `Verifying ${total} email address${total !== 1 ? 'es' : ''}${skipNote} — watch the live log below`);
      localStorage.setItem('active_verify_job', jobId);
      setVerifyJobId(jobId);
      setVerifyStartedAt(new Date().toISOString());
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Verification failed');
    }
  };

  const startEnrich = async (leadIds?: string[]) => {
    try {
      const body = leadIds && leadIds.length > 0 ? { leadIds } : {};
      const res = await api.post('/enrich', body);
      const { jobId, total: t } = res.data.data;
      if (!jobId) {
        notify('success', 'No leads needed enrichment (all already have website emails)');
        return;
      }
      notify('success', `Scanning websites for ${t} lead${t !== 1 ? 's' : ''} — watch the live log below`);
      const startedAt = new Date().toISOString();
      localStorage.setItem('active_enrich_job', jobId);
      localStorage.setItem('active_enrich_started_at', startedAt);
      setEnrichJobId(jobId);
      setEnrichStartedAt(startedAt);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Enrichment failed');
    }
  };

  const handleBulkEnrich = () => startEnrich(selectedIds);
  const handleEnrichAll  = () => startEnrich();

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setDeleting(true);
    try {
      const deleted = await bulkDelete(selectedIds);
      notify('success', `Deleted ${deleted} lead${deleted !== 1 ? 's' : ''}`);
      setSelectedIds([]);
      setConfirmDeleteOpen(false);
      loadLeads();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Failed to delete leads');
    } finally {
      setDeleting(false);
    }
  };

  // Self-healing URL pipeline handlers.
  const handleDismissLinkFlag = async (id: string) => {
    try {
      await api.patch(`/leads/${id}/dismiss-flag`);
      notify('success', 'Link flag dismissed');
      loadLeads();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Failed to dismiss flag');
    }
  };

  const handleEditLinkUrl = async (id: string, url: string) => {
    try {
      await api.patch(`/leads/${id}/url`, { trustpilot_url: url });
      notify('success', 'URL updated — re-validating in background');
      loadLeads();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Failed to update URL');
    }
  };

  const [linkJobId, setLinkJobId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('active_link_check_job');
  });
  const [linkStartedAt, setLinkStartedAt] = useState<string | null>(null);
  const [linkResult, setLinkResult] = useState<{ total: number; valid: number; dead: number; removed: number; unknown: number } | null>(null);
  const linkJob = useCheckLinksJob(linkJobId, 'leads');
  const checkingLinks = linkJob.status === 'running';

  const [claimedJobId, setClaimedJobId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('active_claimed_check_job');
  });
  const [claimedStartedAt, setClaimedStartedAt] = useState<string | null>(null);
  const [claimedResult, setClaimedResult] = useState<{ total: number; claimed: number; unclaimed: number; unknown: number } | null>(null);
  const [claimedFailure, setClaimedFailure] = useState<string | null>(null);
  const claimedJob = useCheckClaimedJob(claimedJobId);
  const checkingClaimed = claimedJob.status === 'running';

  const handleBulkCheckLinks = async () => {
    if (selectedIds.length === 0) return;
    // Block re-entry — double-click would launch a parallel browser/pool
    // and the two jobs would compete for the same memory budget.
    if (checkingLinks || linkJobId) {
      notify('error', 'A link-validation job is already running');
      return;
    }
    try {
      const res = await api.post('/leads/check-links', { ids: selectedIds });
      const { jobId } = res.data.data;
      if (!jobId) {
        notify('error', 'Failed to start link validation');
        return;
      }
      notify('success', `Validating ${selectedIds.length} URL${selectedIds.length === 1 ? '' : 's'} — watch the live log below`);
      localStorage.setItem('active_link_check_job', jobId);
      setLinkJobId(jobId);
      setLinkStartedAt(new Date().toISOString());
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Failed to start link validation');
    }
  };

  const handleBulkCheckClaimed = async () => {
    if (selectedIds.length === 0) return;
    if (checkingClaimed || claimedJobId) {
      notify('error', 'A claimed-check job is already running');
      return;
    }
    try {
      const res = await api.post('/leads/check-claimed', { ids: selectedIds });
      const { jobId } = res.data.data;
      if (!jobId) {
        notify('error', 'Failed to start claimed check');
        return;
      }
      notify('success', `Checking ${selectedIds.length} profile${selectedIds.length === 1 ? '' : 's'} — watch the live log below`);
      localStorage.setItem('active_claimed_check_job', jobId);
      setClaimedJobId(jobId);
      setClaimedStartedAt(new Date().toISOString());
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Failed to start claimed check');
    }
  };

  // React to link-check job reaching a terminal state — same pattern the
  // verify and enrich jobs use above.
  useEffect(() => {
    if (!linkJobId) return;
    if (linkJob.status === 'completed') {
      setLinkResult({
        total: linkJob.summary.total,
        valid: linkJob.summary.valid,
        dead: linkJob.summary.flagged_dead,
        removed: linkJob.summary.flagged_removed,
        unknown: linkJob.summary.unknown,
      });
      setLinkJobId(null);
      setLinkStartedAt(null);
      localStorage.removeItem('active_link_check_job');
      loadLeads();
    } else if (linkJob.status === 'failed') {
      notify('error', `Link validation failed: ${linkJob.error || 'unknown error'}`);
      setLinkJobId(null);
      setLinkStartedAt(null);
      localStorage.removeItem('active_link_check_job');
    }
  }, [linkJob.status, linkJob.summary, linkJob.error, linkJobId, loadLeads]);

  // React to claimed-check job reaching a terminal state.
  useEffect(() => {
    if (!claimedJobId) return;
    if (claimedJob.status === 'completed') {
      setClaimedResult({
        total: claimedJob.summary.total,
        claimed: claimedJob.summary.claimed,
        unclaimed: claimedJob.summary.unclaimed,
        unknown: claimedJob.summary.unknown,
      });
      setClaimedJobId(null);
      setClaimedStartedAt(null);
      localStorage.removeItem('active_claimed_check_job');
      loadLeads();
    } else if (claimedJob.status === 'failed') {
      const msg = claimedJob.error || 'unknown error';
      notify('error', `Claimed check failed: ${msg}`);
      setClaimedFailure(msg);
      setClaimedJobId(null);
      setClaimedStartedAt(null);
      localStorage.removeItem('active_claimed_check_job');
    }
  }, [claimedJob.status, claimedJob.summary, claimedJob.error, claimedJobId, loadLeads]);

  // React to verify job reaching a terminal state
  useEffect(() => {
    if (!verifyJobId) return;
    if (verifyJob.status === 'completed') {
      setVerifyResult({
        total: verifyJob.summary.total,
        verified: verifyJob.summary.verified,
        invalid: verifyJob.summary.invalid,
        catchAll: verifyJob.summary.catchAll,
        unknown: verifyJob.summary.unknown,
      });
      setVerifyJobId(null);
      setVerifyStartedAt(null);
      localStorage.removeItem('active_verify_job');
      loadLeads();
    } else if (verifyJob.status === 'failed') {
      notify('error', `Verification failed: ${verifyJob.error || 'unknown error'}`);
      setVerifyJobId(null);
      setVerifyStartedAt(null);
      localStorage.removeItem('active_verify_job');
    }
  }, [verifyJob.status, verifyJob.summary, verifyJob.error, verifyJobId, loadLeads]);

  // React to the enrichment job reaching a terminal state — clear storage,
  // surface the result banner, and refresh the leads table so new emails show.
  useEffect(() => {
    if (!enrichJobId) return;
    if (enrichJob.status === 'completed') {
      setEnrichResult({
        total: enrichJob.summary.total,
        found: enrichJob.summary.found,
        failed: enrichJob.summary.failed,
      });
      setEnrichJobId(null);
      setEnrichStartedAt(null);
      localStorage.removeItem('active_enrich_job');
      localStorage.removeItem('active_enrich_started_at');
      loadLeads();
    } else if (enrichJob.status === 'failed') {
      notify('error', `Enrichment failed: ${enrichJob.error || 'unknown error'}`);
      setEnrichJobId(null);
      setEnrichStartedAt(null);
      localStorage.removeItem('active_enrich_job');
      localStorage.removeItem('active_enrich_started_at');
      loadLeads();
    }
  }, [enrichJob.status, enrichJob.summary, enrichJob.error, enrichJobId, loadLeads]);

  return (
    <div className="px-6 py-8 xl:px-10 xl:py-10 space-y-8">

      {/* Live verification progress — inline log panel */}
      {verifyJobId && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6">
          <JobProgress
            kind="verify"
            status={verifyJob.status === 'idle' ? 'running' : verifyJob.status}
            progress={verifyJob.progress}
            error={verifyJob.error}
            startedAt={verifyStartedAt}
          />
        </div>
      )}

      {/* Verification result banner */}
      {verifyResult && (
        <div className={`flex items-center gap-3 rounded-xl px-5 py-3 text-sm border ${
          verifyResult.invalid > 0
            ? 'bg-amber-50 border-amber-200 text-amber-800'
            : 'bg-[#8ff9a8]/20 border-[#006630]/20 text-[#006630]'
        }`}>
          <span className={`material-symbols-outlined text-[18px] ${verifyResult.invalid > 0 ? 'text-amber-600' : 'text-[#006630]'}`}>
            {verifyResult.invalid > 0 ? 'warning' : 'verified_user'}
          </span>
          <span className="font-semibold">Verification complete!</span>
          <span className="font-normal">
            <strong>{verifyResult.verified}</strong> valid, <strong>{verifyResult.invalid}</strong> invalid, <strong>{verifyResult.catchAll}</strong> catch-all, <strong>{verifyResult.unknown}</strong> unknown out of <strong>{verifyResult.total}</strong> address{verifyResult.total !== 1 ? 'es' : ''}.
          </span>
          <button
            onClick={() => setVerifyResult(null)}
            className={`ml-auto transition-colors ${verifyResult.invalid > 0 ? 'text-amber-600/60 hover:text-amber-800' : 'text-[#006630]/60 hover:text-[#006630]'}`}
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Live link-check progress — inline log panel */}
      {linkJobId && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6">
          <JobProgress
            kind="check-links"
            status={linkJob.status === 'idle' ? 'running' : linkJob.status}
            progress={linkJob.progress}
            error={linkJob.error}
            startedAt={linkStartedAt}
          />
        </div>
      )}

      {/* Link-check result banner */}
      {linkResult && (
        <div className={`flex items-center gap-3 rounded-xl px-5 py-3 text-sm border ${
          (linkResult.dead + linkResult.removed) > 0
            ? 'bg-amber-50 border-amber-200 text-amber-800'
            : 'bg-[#8ff9a8]/20 border-[#006630]/20 text-[#006630]'
        }`}>
          <span className={`material-symbols-outlined text-[18px] ${(linkResult.dead + linkResult.removed) > 0 ? 'text-amber-600' : 'text-[#006630]'}`}>
            {(linkResult.dead + linkResult.removed) > 0 ? 'warning' : 'check_circle'}
          </span>
          <span className="font-semibold">Link validation complete!</span>
          <span className="font-normal">
            <strong>{linkResult.valid}</strong> valid, <strong>{linkResult.dead}</strong> dead, <strong>{linkResult.removed}</strong> removed, <strong>{linkResult.unknown}</strong> unknown out of <strong>{linkResult.total}</strong> URL{linkResult.total !== 1 ? 's' : ''}.
          </span>
          <button
            onClick={() => setLinkResult(null)}
            className={`ml-auto transition-colors ${(linkResult.dead + linkResult.removed) > 0 ? 'text-amber-600/60 hover:text-amber-800' : 'text-[#006630]/60 hover:text-[#006630]'}`}
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Live claimed-check progress — inline log panel */}
      {claimedJobId && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6">
          <JobProgress
            kind="check-claimed"
            status={claimedJob.status === 'idle' ? 'running' : claimedJob.status}
            progress={claimedJob.progress}
            error={claimedJob.error}
            startedAt={claimedStartedAt}
          />
        </div>
      )}

      {/* Claimed-check result banner */}
      {claimedResult && (
        <div className="flex items-center gap-3 rounded-xl px-5 py-3 text-sm border bg-[#8ff9a8]/20 border-[#006630]/20 text-[#006630]">
          <span className="material-symbols-outlined text-[18px] text-[#006630]">check_circle</span>
          <span className="font-semibold">Profile claimed check complete!</span>
          <span className="font-normal">
            <strong>{claimedResult.claimed}</strong> claimed, <strong>{claimedResult.unclaimed}</strong> unclaimed, <strong>{claimedResult.unknown}</strong> unknown out of <strong>{claimedResult.total}</strong> profile{claimedResult.total !== 1 ? 's' : ''}.
          </span>
          <button
            onClick={() => setClaimedResult(null)}
            className="ml-auto transition-colors text-[#006630]/60 hover:text-[#006630]"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Claimed-check failure banner — persistent, since the underlying cause
          (instance recycle mid-job) leaves no completion event for the UI. */}
      {claimedFailure && (
        <div className="flex items-center gap-3 rounded-xl px-5 py-3 text-sm border bg-rose-100 border-rose-300 text-rose-800">
          <span className="material-symbols-outlined text-[18px]">error</span>
          <span className="font-semibold">Claimed check did not complete:</span>
          <span className="font-normal">{claimedFailure}. Re-running usually fixes it.</span>
          <button
            onClick={() => setClaimedFailure(null)}
            className="ml-auto transition-colors text-rose-800/60 hover:text-rose-800"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Live enrichment progress — inline log panel */}
      {enrichJobId && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6 space-y-4">
          {enrichJob.stalled && (
            <div className="flex items-start gap-3 rounded-xl px-5 py-3 text-sm border bg-amber-50 border-amber-200 text-amber-800">
              <span className="material-symbols-outlined text-[18px] text-amber-600 shrink-0 mt-0.5">warning</span>
              <div className="flex-1">
                <p className="font-semibold">Enrichment looks stuck</p>
                <p className="text-xs mt-0.5 text-amber-700/90">
                  No progress for more than 90s. The backend may have been killed by a deploy or crashed mid-job.
                  The orphan reaper will mark this failed within 3 minutes — or click Clear to reset now and re-run.
                </p>
              </div>
              <button
                onClick={() => {
                  setEnrichJobId(null);
                  setEnrichStartedAt(null);
                  localStorage.removeItem('active_enrich_job');
                  localStorage.removeItem('active_enrich_started_at');
                  notify('success', 'Enrichment job cleared. You can run it again.');
                }}
                className="ml-2 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold transition-colors shrink-0"
              >
                Clear
              </button>
            </div>
          )}
          <JobProgress
            kind="enrichment"
            status={enrichJob.status === 'idle' ? 'running' : enrichJob.status}
            progress={enrichJob.progress}
            error={enrichJob.error}
            startedAt={enrichStartedAt}
            liveEnrich={{
              total: enrichJob.summary.total,
              found: enrichJob.summary.found,
              failed: enrichJob.summary.failed,
            }}
          />
        </div>
      )}

      {/* Enrichment success banner — stays until dismissed */}
      {enrichResult && (
        <div className={`flex items-center gap-3 rounded-xl px-5 py-3 text-sm border ${
          enrichResult.failed > 0
            ? 'bg-amber-50 border-amber-200 text-amber-800'
            : 'bg-[#8ff9a8]/20 border-[#006630]/20 text-[#006630]'
        }`}>
          <span className={`material-symbols-outlined text-[18px] ${enrichResult.failed > 0 ? 'text-amber-600' : 'text-[#006630]'}`}>
            {enrichResult.failed > 0 ? 'warning' : 'check_circle'}
          </span>
          <span className="font-semibold">Enrichment complete!</span>
          <span className="font-normal">
            Found <strong>{enrichResult.found}</strong> email{enrichResult.found !== 1 ? 's' : ''} out of <strong>{enrichResult.total}</strong> lead{enrichResult.total !== 1 ? 's' : ''}.
            {enrichResult.failed > 0 && (
              <> <strong className="text-red-600">{enrichResult.failed}</strong> failed to save.</>
            )}
          </span>
          <button
            onClick={() => setEnrichResult(null)}
            className={`ml-auto transition-colors ${enrichResult.failed > 0 ? 'text-amber-600/60 hover:text-amber-800' : 'text-[#006630]/60 hover:text-[#006630]'}`}
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap justify-between items-end gap-4">
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
        {/* flex-wrap so the chip group + rate-limit + Enrich All + view toggle
            fall onto a second row instead of overflowing the viewport at the
            ~1100–1280px range where most laptop/external-monitor combos sit. */}
        <div className="flex flex-wrap items-center gap-3 justify-end max-w-full">
          {selectedIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-0.5 bg-white rounded-full ambient-shadow border border-slate-100 pl-3 pr-1 py-1">
              <span className="text-xs font-bold text-on-surface mr-1">
                {selectedIds.length}<span className="text-secondary font-medium ml-1">selected</span>
              </span>
              <div className="w-px h-5 bg-slate-200 mx-1" />

              {/* Enrich */}
              <button
                onClick={handleBulkEnrich}
                disabled={enriching || verifying || checkingLinks || checkingClaimed}
                title={enriching ? 'Enriching...' : `Enrich ${selectedIds.length} — visits each company website and scrapes their contact email`}
                className="p-2 rounded-full text-[#006630] hover:bg-[#006630]/10 disabled:opacity-50 transition-colors"
              >
                <span className={`material-symbols-outlined text-[18px] ${enriching ? 'animate-spin' : ''}`}>
                  {enriching ? 'progress_activity' : 'language'}
                </span>
              </button>

              {/* Validate Links — re-checks Trustpilot URLs for dead/removed pages */}
              <button
                onClick={handleBulkCheckLinks}
                disabled={checkingLinks || enriching || verifying || checkingClaimed}
                title={checkingLinks ? 'Checking links...' : `Validate Links — re-checks each Trustpilot URL for dead/removed pages and flags broken ones`}
                className="p-2 rounded-full text-amber-700 hover:bg-amber-50 disabled:opacity-50 transition-colors"
              >
                <span className={`material-symbols-outlined text-[18px] ${checkingLinks ? 'animate-spin' : ''}`}>
                  {checkingLinks ? 'progress_activity' : 'link'}
                </span>
              </button>

              {/* Check Claimed — re-detects Trustpilot "Profile claimed" badge */}
              <button
                onClick={handleBulkCheckClaimed}
                disabled={checkingClaimed || checkingLinks || enriching || verifying}
                title={checkingClaimed ? 'Checking claimed...' : `Check Claimed — visits each Trustpilot profile and updates whether the business has claimed it`}
                className="p-2 rounded-full text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 transition-colors"
              >
                <span className={`material-symbols-outlined text-[18px] ${checkingClaimed ? 'animate-spin' : ''}`}>
                  {checkingClaimed ? 'progress_activity' : 'shield_person'}
                </span>
              </button>

              {/* Verify + email-field selector */}
              <div className="flex items-center">
                <button
                  onClick={handleBulkVerify}
                  disabled={verifying || enriching || checkingLinks || checkingClaimed}
                  title={verifying ? 'Verifying...' : `Verify ${selectedIds.length} (${verifyEmailField}) — checks deliverability via ZeroBounce`}
                  className="p-2 rounded-l-full text-blue-700 hover:bg-blue-50 disabled:opacity-50 transition-colors"
                >
                  <span className={`material-symbols-outlined text-[18px] ${verifying ? 'animate-spin' : ''}`}>
                    {verifying ? 'progress_activity' : 'verified_user'}
                  </span>
                </button>
                <select
                  value={verifyEmailField}
                  onChange={(e) => setVerifyEmailField(e.target.value as 'trustpilot' | 'website' | 'affiliate' | 'all')}
                  disabled={verifying || enriching || checkingLinks || checkingClaimed}
                  title="Which email to verify"
                  className="text-[10px] font-bold text-blue-700 bg-transparent border-0 pl-0.5 pr-1.5 py-1.5 cursor-pointer focus:outline-none rounded-r-full hover:bg-blue-50 disabled:opacity-50 uppercase tracking-wide"
                >
                  <option value="trustpilot">TP</option>
                  <option value="website">Web</option>
                  <option value="affiliate">Affil</option>
                  <option value="all">All</option>
                </select>
              </div>

              {/* Send */}
              <button
                onClick={() => setQuickSendOpen(true)}
                disabled={verifying || enriching || checkingLinks || checkingClaimed}
                title={`Send ${selectedIds.length} — quick one-off email without creating a full campaign`}
                className="p-2 rounded-full text-[#b0004a] hover:bg-[#ffd9de]/40 disabled:opacity-50 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">send</span>
              </button>

              {/* Delete */}
              <button
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={verifying || enriching || checkingLinks || checkingClaimed || deleting}
                title={deleting ? 'Deleting...' : `Delete ${selectedIds.length} — permanently removes the selected leads`}
                className="p-2 rounded-full text-error hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                <span className={`material-symbols-outlined text-[18px] ${deleting ? 'animate-spin' : ''}`}>
                  {deleting ? 'progress_activity' : 'delete'}
                </span>
              </button>
            </div>
          )}
          {/* Enrich All — always visible, enriches every lead missing website_email */}
          <button
            onClick={handleEnrichAll}
            disabled={enriching}
            title="Enrich All — visits every company website and finds their contact email. Only runs on leads that don't have a website email yet."
            className="flex items-center gap-2 px-3.5 py-2 rounded-full border border-[#006630]/30 text-[#006630] text-xs font-bold hover:bg-[#006630]/5 disabled:opacity-50 transition-colors"
          >
            <span className={`material-symbols-outlined text-[16px] ${enriching ? 'animate-spin' : ''}`}>
              {enriching ? 'progress_activity' : 'travel_explore'}
            </span>
            {enriching ? 'Enriching…' : 'Enrich All'}
          </button>

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
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
            onLeadClick={(id) => router.push(`/leads/${id}`)}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={toggleSort}
            onDismissLinkFlag={handleDismissLinkFlag}
            onEditLinkUrl={handleEditLinkUrl}
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

      {confirmDeleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl ambient-shadow max-w-md w-full p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="rounded-full bg-[#ffd9de] p-2">
                <span className="material-symbols-outlined text-[#b0004a]">delete_forever</span>
              </div>
              <div>
                <h3 className="text-lg font-bold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                  Delete {selectedIds.length} lead{selectedIds.length !== 1 ? 's' : ''}?
                </h3>
                <p className="text-sm text-secondary mt-1">
                  This permanently removes the selected leads and their notes, follow-ups, and campaign history. This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmDeleteOpen(false)}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-bold text-secondary hover:bg-surface-container transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={deleting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#b0004a] text-white text-sm font-bold hover:bg-[#900040] transition-colors disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {deleting ? 'progress_activity' : 'delete'}
                </span>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

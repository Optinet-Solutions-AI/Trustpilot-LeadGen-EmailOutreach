'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useScrape } from '../hooks/useScrape';
import { useTaxonomy } from '../hooks/useTaxonomy';
import ScrapeForm from '../components/ScrapeForm';
import ActiveScrapeCard from '../components/ActiveScrapeCard';
import type { ScrapeParams } from '../types/scrape';
import api from '../api/client';
import Button from '../ui/Button';
import Card from '../ui/Card';
import IconButton from '../ui/IconButton';
import Pill from '../ui/Pill';
import SectionHeader from '../ui/SectionHeader';
import Stat from '../ui/Stat';

function relativeFromNow(iso: string | null): string {
  if (!iso) return 'Never refreshed';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'Never refreshed';
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return 'Refreshed just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `Refreshed ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Refreshed ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `Refreshed ${days}d ago`;
}

// Platform badge metadata — color tokens tuned to each brand without
// being literal trademarks. Used by the Recent Scrape Jobs table.
const PLATFORM_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  trustpilot:   { label: 'Trustpilot',   bg: 'bg-emerald-50',  fg: 'text-emerald-700' },
  tripadvisor:  { label: 'TripAdvisor',  bg: 'bg-teal-50',     fg: 'text-teal-700' },
  yelp:         { label: 'Yelp',         bg: 'bg-rose-50',     fg: 'text-rose-700' },
};

const PLATFORM_FILTERS: Array<{ value: string | null; label: string }> = [
  { value: null,           label: 'All platforms' },
  { value: 'trustpilot',   label: 'Trustpilot' },
  { value: 'tripadvisor',  label: 'TripAdvisor' },
  { value: 'yelp',         label: 'Yelp' },
];

export default function Scrape() {
  const {
    activeScrapes, jobs, jobsTotal, jobsPlatformFilter, setJobsPlatformFilter,
    jobsLoading, jobsPage, jobsPageSize, setJobsPage, error,
    startScrape, dismissScrape, fetchJobs, deleteJob, cleanupEmptyJobs,
  } = useScrape();
  const taxonomy = useTaxonomy();
  const router = useRouter();
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const openLeadsForJob = (job: typeof jobs[number]) => {
    const params = new URLSearchParams();
    // 1. Carry the platform forward so the Lead Matrix filters to THIS
    //    platform's leads only — without this, clicking '17 FOUND' on a
    //    TripAdvisor job opened a Lead Matrix view filled with Trustpilot
    //    leads that happened to share the country.
    const platform = (job.platform || 'trustpilot').toLowerCase();
    params.set('platform', platform);

    // 2. For non-Trustpilot jobs the top-level country/category columns
    //    are placeholders (_yelp_ / _tripadvisor_ / all) — the real values
    //    live in `filters` jsonb. Read the real ones for the Lead Matrix
    //    query, otherwise the filter would match nothing.
    const f = (job.filters || null) as { country?: string; category?: string } | null;
    const realCountry =
      job.country && !job.country.startsWith('_') ? job.country : f?.country;
    const realCategory =
      job.category && job.category !== 'all' ? job.category : f?.category;
    if (realCountry) params.set('country', realCountry);
    if (realCategory) params.set('category', realCategory);

    router.push(`/leads?${params.toString()}`);
  };

  const handleCleanup = async () => {
    if (!confirm('Delete all completed/failed scrape jobs whose country + category has zero leads in the Lead Matrix?')) return;
    setCleaning(true);
    const removed = await cleanupEmptyJobs();
    setCleaning(false);
    alert(removed > 0 ? `Removed ${removed} stale job${removed === 1 ? '' : 's'}.` : 'No stale jobs found.');
  };

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  useEffect(() => {
    api.get('/health').then(() => setApiReady(true)).catch(() => setApiReady(false));
  }, []);

  const handleSubmit = (params: ScrapeParams) => startScrape(params);

  const runningCount = jobs.filter((j) => j.status === 'running').length;
  const lastDone = jobs.find((j) => j.status !== 'running');

  // Surface in-flight work above finished work so the user never scrolls past
  // history to see what is happening RIGHT NOW. Within each group, newest-first.
  const STATUS_RANK: Record<string, number> = { running: 0, pending: 1, failed: 2, completed: 3 };
  const orderedJobs = [...jobs].sort((a, b) => {
    const ar = STATUS_RANK[a.status] ?? 99;
    const br = STATUS_RANK[b.status] ?? 99;
    if (ar !== br) return ar - br;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const taxonomyHelper = useMemo(() => {
    if (taxonomy.refreshing) {
      const stage = taxonomy.refreshProgress?.stage ?? 'starting';
      const pretty: Record<string, string> = {
        starting: 'Refreshing…',
        loading_index: 'Loading Trustpilot index…',
        top_level_done: 'Indexing categories…',
        expand_start: 'Harvesting subcategories…',
        expand_progress: `Harvesting subcategories ${taxonomy.refreshProgress?.detail ?? ''}`,
        expand_done: 'Subcategories collected',
        countries_done: 'Listing markets…',
        saving_categories: 'Saving categories…',
        saving_countries: 'Saving countries…',
      };
      return pretty[stage] ?? `Refreshing… (${stage})`;
    }
    return relativeFromNow(taxonomy.lastSeenAt);
  }, [taxonomy.refreshing, taxonomy.refreshProgress, taxonomy.lastSeenAt]);

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-8 xl:px-10 xl:py-10 space-y-4 sm:space-y-8">
      <SectionHeader
        title="Lead Scraping"
        accent="Dashboard"
        subtitle="Configure and execute high-performance lead extraction from review and social platforms."
        actions={
          <Pill variant="brand" size="md" className="!text-[10px]">
            Powered by EC2 Worker (Singapore)
          </Pill>
        }
      />

      {/* Main Grid */}
      <div className="grid grid-cols-12 gap-3 sm:gap-5 xl:gap-6">
        {/* Scrape Config */}
        <div className="col-span-12 xl:col-span-8">
          <Card
            header={
              <h3
                className="text-xl font-extrabold text-on-surface"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                New Scrape
              </h3>
            }
            actions={
              runningCount > 0 ? (
                <Pill variant="running" pulse>{runningCount} running</Pill>
              ) : (
                <Pill variant="neutral">Ready</Pill>
              )
            }
          >
            {/* No loading lock — backend supports up to MAX_CONCURRENT_JOBS=3 concurrent.
                ScrapeForm's submittingRef prevents double-click double-POSTs. */}
            <ScrapeForm onSubmit={handleSubmit} loading={false} />
            {error && (
              <div className="mt-4 px-4 py-3 rounded-lg bg-error-container text-error text-sm font-medium">
                {error}
              </div>
            )}
          </Card>
        </div>

        {/* Stats Panel */}
        <div className="col-span-12 xl:col-span-4 space-y-4">
          <Stat
            icon="group"
            label="Total Jobs Run"
            value={jobsTotal || jobs.length}
            helper={
              jobsPlatformFilter
                ? `filtered: ${PLATFORM_BADGE[jobsPlatformFilter]?.label ?? jobsPlatformFilter}`
                : 'across all platforms'
            }
          />

          {lastDone && (
            <Stat
              icon="history"
              label="Last Scrape"
              value={
                <span className="text-base">
                  {lastDone.category} <span className="text-secondary">—</span> {lastDone.country}
                </span>
              }
              helper={
                <>
                  {lastDone.total_scraped ?? lastDone.total_found ?? 0} leads found
                  {lastDone.status === 'failed' && (
                    <span className="ml-2 text-[#b0004a] font-bold">· failed</span>
                  )}
                </>
              }
            />
          )}

          <Stat
            icon="category"
            label="Taxonomy"
            tone={taxonomy.error ? 'neutral' : 'brand'}
            value={
              taxonomy.loading && taxonomy.categories.length === 0
                ? 'Loading…'
                : (
                  <span className="text-base">
                    {taxonomy.categories.length} cats <span className="text-secondary">·</span>{' '}
                    {taxonomy.countries.length} countries
                  </span>
                )
            }
            helper={taxonomy.error ?? taxonomyHelper}
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => taxonomy.refresh()}
                disabled={taxonomy.refreshing}
                loading={taxonomy.refreshing}
              >
                {taxonomy.refreshing ? 'Refreshing' : 'Refresh'}
              </Button>
            }
          />

          {apiReady !== null && !apiReady && (
            <Card variant="compact">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#b0004a] inline-block" />
                <span className="text-xs font-bold uppercase tracking-wide text-[#b0004a]">
                  Infrastructure Offline
                </span>
              </div>
              <p className="text-xs text-secondary mt-1">
                Cannot reach the API server. Check your connection.
              </p>
            </Card>
          )}
        </div>
      </div>

      {/* Active scrape cards — one per in-flight job */}
      {activeScrapes.length > 0 && (
        <div className="space-y-4">
          {activeScrapes.map((id) => {
            const job = jobs.find((j) => j.id === id) ?? null;
            return (
              <ActiveScrapeCard
                key={id}
                jobId={id}
                initialJob={job}
                onDismiss={() => dismissScrape(id)}
              />
            );
          })}
        </div>
      )}

      {/* Recent Jobs Table */}
      {(jobs.length > 0 || jobsPlatformFilter !== null) && (
        <Card
          variant="flush"
          header={
            <div className="flex items-center gap-3 flex-wrap">
              <h3
                className="font-bold text-on-surface"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                Recent Scrape Jobs
              </h3>
              <span className="text-xs text-secondary font-medium">
                {jobsTotal} job{jobsTotal === 1 ? '' : 's'} total
              </span>
            </div>
          }
          actions={
            <button
              onClick={handleCleanup}
              disabled={cleaning}
              className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-[#b0004a] hover:text-[#8a003a] disabled:text-slate-300 disabled:cursor-not-allowed transition-colors"
              title="Delete jobs with no leads in the Lead Matrix"
            >
              <span className="material-symbols-outlined text-[16px]">cleaning_services</span>
              {cleaning ? 'Cleaning…' : 'Clean Stale Jobs'}
            </button>
          }
        >
          {/* Platform filter chips */}
          <div className="px-4 sm:px-6 pt-3 pb-1 flex flex-wrap gap-2 border-b border-slate-100">
            {PLATFORM_FILTERS.map((f) => {
              const active = jobsPlatformFilter === f.value;
              return (
                <button
                  key={f.label}
                  type="button"
                  onClick={() => setJobsPlatformFilter(f.value)}
                  className={
                    'px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ' +
                    (active
                      ? 'bg-[#b0004a] text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200')
                  }
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="sticky top-14 lg:top-16 z-10 shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
                <tr className="bg-slate-50/95 backdrop-blur-sm">
                  {['Platform', 'Target', 'Rating', 'Status', 'Results', 'Date', ''].map((h, i) => (
                    <th
                      key={h || `col-${i}`}
                      className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {orderedJobs.map((job) => {
                  const isCompleted = job.status === 'completed';
                  const statusVariant =
                    isCompleted ? 'success'
                    : job.status === 'running' ? 'running'
                    : job.status === 'failed' ? 'error'
                    : 'neutral';
                  const platKey = (job.platform || 'trustpilot').toLowerCase();
                  const platMeta = PLATFORM_BADGE[platKey] ?? { label: platKey, bg: 'bg-slate-100', fg: 'text-slate-600' };
                  // For non-Trustpilot jobs the legacy country/category
                  // columns hold placeholders ('_yelp_' / '_tripadvisor_'
                  // / 'all'); the real values live in `filters` jsonb.
                  // Without this fallback the row shows "all / _yelp_"
                  // even though the scrape actually targeted plumbing/AU.
                  const f = (job.filters || null) as { country?: string; category?: string } | null;
                  const displayCountry =
                    job.country && !job.country.startsWith('_')
                      ? job.country
                      : f?.country ?? job.country ?? '';
                  const displayCategory =
                    job.category && job.category !== 'all'
                      ? job.category
                      : f?.category ?? job.category ?? '';
                  return (
                    <tr
                      key={job.id}
                      className={`transition-colors ${
                        isCompleted
                          ? 'cursor-pointer hover:bg-[#ffd9de]/40'
                          : 'hover:bg-surface-container/40'
                      }`}
                      onClick={isCompleted ? () => openLeadsForJob(job) : undefined}
                      title={isCompleted ? 'Open these leads in the Lead Matrix' : undefined}
                    >
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold ${platMeta.bg} ${platMeta.fg}`}>
                          {platMeta.label}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="font-bold text-sm text-on-surface leading-tight">{displayCategory}</span>
                          <span className="text-[11px] text-secondary mt-0.5">{displayCountry}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-secondary whitespace-nowrap">
                        {job.min_rating}–{job.max_rating}★
                      </td>
                      <td className="px-6 py-4">
                        <Pill variant={statusVariant} size="sm">{job.status}</Pill>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-baseline gap-3 text-sm whitespace-nowrap">
                          <span className="font-bold text-on-surface">{job.total_found ?? 0}</span>
                          <span className="text-[10px] uppercase tracking-wider text-secondary">found</span>
                          {(job.total_scraped ?? 0) > 0 && (
                            <>
                              <span className="text-secondary">·</span>
                              <span className="font-bold text-on-surface">{job.total_scraped}</span>
                              <span className="text-[10px] uppercase tracking-wider text-secondary">scraped</span>
                            </>
                          )}
                          {(job.total_failed ?? 0) > 0 && (
                            <>
                              <span className="text-secondary">·</span>
                              <span className="font-bold text-error">{job.total_failed}</span>
                              <span className="text-[10px] uppercase tracking-wider text-error">failed</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-xs text-secondary whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          {new Date(job.created_at).toLocaleDateString()}
                          {isCompleted && (
                            <span className="material-symbols-outlined text-[14px] text-[#b0004a]" aria-hidden>
                              arrow_forward
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                        {job.status !== 'running' && (
                          <IconButton
                            icon={<span className="material-symbols-outlined text-[18px]">delete</span>}
                            label="Delete job"
                            tone="danger"
                            size="sm"
                            onClick={() => {
                              if (confirm(`Delete this ${job.category} / ${job.country} scrape job from the list? Leads already saved are kept.`)) {
                                deleteJob(job.id);
                              }
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
                {orderedJobs.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-sm text-secondary">
                      No jobs match this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {jobsTotal > jobsPageSize && (() => {
            const totalPages = Math.max(1, Math.ceil(jobsTotal / jobsPageSize));
            const firstIdx = (jobsPage - 1) * jobsPageSize + 1;
            const lastIdx = Math.min(firstIdx + jobs.length - 1, jobsTotal);
            // Compact page numbers: always show first, current ±1, last; ellipses elsewhere.
            const pageNums: Array<number | 'gap'> = [];
            const push = (n: number) => { if (!pageNums.includes(n)) pageNums.push(n); };
            push(1);
            for (let p = jobsPage - 1; p <= jobsPage + 1; p++) {
              if (p > 1 && p < totalPages) push(p);
            }
            if (totalPages > 1) push(totalPages);
            // Insert 'gap' markers where there's a jump > 1
            const withGaps: Array<number | 'gap'> = [];
            for (let i = 0; i < pageNums.length; i++) {
              const cur = pageNums[i] as number;
              if (i > 0) {
                const prev = pageNums[i - 1] as number;
                if (cur - prev > 1) withGaps.push('gap');
              }
              withGaps.push(cur);
            }
            return (
              <div className="px-4 sm:px-6 py-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-secondary font-medium">
                  Showing <span className="font-semibold text-on-surface">{firstIdx}–{lastIdx}</span> of{' '}
                  <span className="font-semibold text-on-surface">{jobsTotal}</span>
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setJobsPage(jobsPage - 1)}
                    disabled={jobsPage <= 1 || jobsLoading}
                    className="px-2.5 py-1.5 rounded-md text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Previous page"
                  >
                    ‹ Prev
                  </button>
                  {withGaps.map((p, i) =>
                    p === 'gap' ? (
                      <span key={`gap-${i}`} className="px-1 text-xs text-slate-400 select-none">
                        …
                      </span>
                    ) : (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setJobsPage(p)}
                        disabled={jobsLoading}
                        className={
                          'min-w-[32px] px-2 py-1.5 rounded-md text-xs font-semibold transition-colors ' +
                          (p === jobsPage
                            ? 'bg-[#b0004a] text-white shadow-sm'
                            : 'text-slate-600 hover:bg-slate-100')
                        }
                        aria-current={p === jobsPage ? 'page' : undefined}
                      >
                        {p}
                      </button>
                    ),
                  )}
                  <button
                    type="button"
                    onClick={() => setJobsPage(jobsPage + 1)}
                    disabled={jobsPage >= totalPages || jobsLoading}
                    className="px-2.5 py-1.5 rounded-md text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Next page"
                  >
                    Next ›
                  </button>
                </div>
              </div>
            );
          })()}
        </Card>
      )}
    </div>
  );
}

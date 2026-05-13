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

export default function Scrape() {
  const {
    activeScrapes, jobs, error,
    startScrape, dismissScrape, fetchJobs, deleteJob, cleanupEmptyJobs,
  } = useScrape();
  const taxonomy = useTaxonomy();
  const router = useRouter();
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const openLeadsForJob = (job: typeof jobs[number]) => {
    const params = new URLSearchParams();
    if (job.country) params.set('country', job.country);
    if (job.category) params.set('category', job.category);
    router.push(`/leads${params.toString() ? `?${params.toString()}` : ''}`);
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
        subtitle="Configure and execute high-performance lead extraction from Trustpilot."
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
                Scrape Trustpilot
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
          <Stat icon="group" label="Total Jobs Run" value={jobs.length} />

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
      {jobs.length > 0 && (
        <Card
          variant="flush"
          header={
            <h3
              className="font-bold text-on-surface"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              Recent Scrape Jobs
            </h3>
          }
          actions={
            <>
              <button
                onClick={handleCleanup}
                disabled={cleaning}
                className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-[#b0004a] hover:text-[#8a003a] disabled:text-slate-300 disabled:cursor-not-allowed transition-colors"
                title="Delete jobs with no leads in the Lead Matrix"
              >
                <span className="material-symbols-outlined text-[16px]">cleaning_services</span>
                {cleaning ? 'Cleaning…' : 'Clean Stale Jobs'}
              </button>
              <span className="text-xs text-secondary font-medium">
                Showing {jobs.length} job{jobs.length !== 1 ? 's' : ''}
              </span>
            </>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="sticky top-14 lg:top-16 z-10 shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
                <tr className="bg-slate-50/95 backdrop-blur-sm">
                  {['Category', 'Country', 'Rating', 'Status', 'Found', 'Scraped', 'Failed', 'Date', ''].map((h, i) => (
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
                      <td className="px-6 py-4 font-bold text-sm text-on-surface">{job.category}</td>
                      <td className="px-6 py-4 text-sm text-secondary">{job.country}</td>
                      <td className="px-6 py-4 text-sm text-secondary">{job.min_rating}–{job.max_rating}★</td>
                      <td className="px-6 py-4">
                        <Pill variant={statusVariant} size="sm">{job.status}</Pill>
                      </td>
                      <td className="px-6 py-4 text-sm font-medium">{job.total_found}</td>
                      <td className="px-6 py-4 text-sm font-medium">{job.total_scraped}</td>
                      <td className={`px-6 py-4 text-sm font-medium ${job.total_failed ? 'text-error' : 'text-secondary'}`}>
                        {job.total_failed || 0}
                      </td>
                      <td className="px-6 py-4 text-xs text-secondary">
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
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

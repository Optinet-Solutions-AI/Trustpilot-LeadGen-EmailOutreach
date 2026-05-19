'use client';

/**
 * Scrape context — tracks the list of in-flight scrape job IDs the user
 * is actively monitoring (rendered as a stack of <ActiveScrapeCard /> on
 * the Scrape page) plus the recent-jobs list polled from the server.
 *
 * SSE and per-job progress state are owned by ActiveScrapeCard, not here.
 * This context only tracks the array of card IDs + does DB list polling.
 *
 * Backward-compat: `jobId` / `status` / `progress` / `error` / `failedCount`
 * remain on the context value so older consumers (Sidebar's running badge,
 * etc.) keep working. They're derived from `activeScrapes` + `jobs`.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import api from '../api/client';
import type { ScrapeParams, ScrapeJob, ScrapeProgress } from '../types/scrape';

interface ScrapeContextValue {
  /** Job IDs currently rendered as live progress cards on the Scrape page. */
  activeScrapes: string[];
  jobs: ScrapeJob[];
  /** Total number of scrape jobs on the server (vs jobs.length which is the page loaded). */
  jobsTotal: number;
  /** Currently active platform filter for the jobs table. null = all platforms. */
  jobsPlatformFilter: string | null;
  setJobsPlatformFilter: (platform: string | null) => void;
  /** Whether a load-more / refetch is currently in flight. */
  jobsLoading: boolean;
  /** Current 1-based page in the Recent Scrape Jobs table. */
  jobsPage: number;
  /** Fixed page size for the table. */
  jobsPageSize: number;
  /** Jump to a specific 1-based page in the table (replaces visible rows). */
  setJobsPage: (page: number) => void;
  startScrape: (params: ScrapeParams) => Promise<string | null>;
  /** Remove a finished card from the stack. Does NOT cancel the job. */
  dismissScrape: (id: string) => void;
  cancelJob: (id: string) => Promise<void>;
  retryFailed: (id: string) => Promise<string | null>;
  fetchJobs: () => Promise<void>;
  deleteJob: (id: string) => Promise<void>;
  cleanupEmptyJobs: () => Promise<number>;

  // ── Backward-compat shims (read-only views) ─────────────────────
  jobId: string | null;
  status: ScrapeJob['status'] | null;
  progress: ScrapeProgress[];
  error: string | null;
  failedCount: number;
}

const ScrapeContext = createContext<ScrapeContextValue | null>(null);

const STORAGE_KEY = 'active_scrape_jobs_v2';
const JOBS_POLL_MS = 5000;

function readStored(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeStored(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage can fail in private windows; ignore.
  }
}

const JOBS_PAGE_SIZE = 25;

export function ScrapeProvider({ children }: { children: ReactNode }) {
  const [activeScrapes, setActiveScrapes] = useState<string[]>([]);
  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const [jobsTotal, setJobsTotal] = useState(0);
  const [jobsPlatformFilter, setJobsPlatformFilterState] = useState<string | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsPage, setJobsPageState] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // Synchronous lock so burst clicks can't fire duplicate POSTs in the
  // same tick. Single shared lock — once one POST is in flight nothing
  // else can submit until it resolves, regardless of country/category.
  const submittingRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hydratedRef = useRef(false);

  // Hydrate active scrapes from localStorage on first mount (browser only)
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const stored = readStored();
    if (stored.length > 0) setActiveScrapes(stored);
  }, []);

  // Persist active scrapes whenever the array changes
  useEffect(() => {
    if (!hydratedRef.current) return;
    writeStored(activeScrapes);
  }, [activeScrapes]);

  // Page-aware fetch — replaces visible rows with the requested page slice.
  // Used by every consumer: initial mount, background poller, platform-filter
  // change, and explicit page navigation via setJobsPage().
  const fetchJobsForPage = useCallback(
    async (page: number, platform: string | null) => {
      try {
        setJobsLoading(true);
        const safePage = Math.max(1, page);
        const offset = (safePage - 1) * JOBS_PAGE_SIZE;
        const params = new URLSearchParams();
        params.set('limit', String(JOBS_PAGE_SIZE));
        params.set('offset', String(offset));
        if (platform) params.set('platform', platform);
        const res = await api.get(`/scrape?${params.toString()}`);
        const payload = res.data.data;
        // Backwards-compat: old API returned ScrapeJob[]; new returns {rows,total}
        const rows = (Array.isArray(payload) ? payload : payload?.rows ?? []) as ScrapeJob[];
        const total = Array.isArray(payload) ? rows.length : (payload?.total ?? rows.length);

        setJobs(rows);
        setJobsTotal(total);

        // Auto-promote any 'running' jobs on the visible page into the card
        // stack so the operator sees live progress. This is fine to do per-
        // page because the worker writes status='running' whenever a job is
        // claimed, regardless of where it falls in the paginated list.
        const running = rows.filter((j) => j.status === 'running').map((j) => j.id);
        if (running.length > 0) {
          setActiveScrapes((prev) => {
            const merged = [...prev];
            for (const id of running) {
              if (!merged.includes(id)) merged.push(id);
            }
            return merged;
          });
        }
      } catch {
        // silent — jobs list is non-critical
      } finally {
        setJobsLoading(false);
      }
    },
    [],
  );

  // Public refetch — always re-pulls the CURRENT page. Used by the 5s
  // background poller so an in-flight job's stats update without changing
  // the operator's view.
  const fetchJobs = useCallback(
    () => fetchJobsForPage(jobsPage, jobsPlatformFilter),
    [fetchJobsForPage, jobsPage, jobsPlatformFilter],
  );

  // Page navigation — wraps the state setter so navigation always triggers
  // a fetch, and clamps to valid bounds.
  const setJobsPage = useCallback(
    (page: number) => {
      const maxPage = Math.max(1, Math.ceil(jobsTotal / JOBS_PAGE_SIZE));
      const clamped = Math.min(Math.max(page, 1), maxPage);
      setJobsPageState(clamped);
      void fetchJobsForPage(clamped, jobsPlatformFilter);
    },
    [fetchJobsForPage, jobsPlatformFilter, jobsTotal],
  );

  // Platform filter change → snap back to page 1 (otherwise the user could
  // land on page 5 of a filter that only has 2 pages).
  const setJobsPlatformFilter = useCallback(
    (platform: string | null) => {
      setJobsPlatformFilterState(platform);
      setJobsPageState(1);
      void fetchJobsForPage(1, platform);
    },
    [fetchJobsForPage],
  );

  // Background jobs-list poller — runs continuously while the provider is mounted.
  // Cheap (one GET every 5s) and keeps the Recent Jobs table fresh.
  useEffect(() => {
    pollRef.current = setInterval(() => { void fetchJobs(); }, JOBS_POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchJobs]);

  const startScrape = useCallback(async (params: ScrapeParams) => {
    // Synchronous burst-click protection only. NO concurrency block —
    // the user is allowed to start up to MAX_CONCURRENT_JOBS scrapes;
    // the EC2 worker handles parallelism server-side.
    if (submittingRef.current) return null;
    submittingRef.current = true;
    setError(null);
    try {
      // Translate the discriminated union to the API body shape.
      // Trustpilot keeps the legacy flat shape (country/category/min/max);
      // TripAdvisor uses the new {platform, filters} envelope because its
      // filters don't fit the legacy shape. Backend accepts both — see
      // POST /api/scrape in server/src/routes/scrape.ts.
      let body: unknown;
      if (params.platform === 'tripadvisor') {
        body = {
          platform: 'tripadvisor',
          filters: {
            country: params.country,
            category: params.category,
            min_rating: params.min_rating,
            max_rating: params.max_rating,
            enrich: params.enrich,
            verify: params.verify,
          },
          forceRescrape: params.forceRescrape,
        };
      } else if (params.platform === 'yelp') {
        body = {
          platform: 'yelp',
          filters: {
            country: params.country,
            category: params.category,
            min_rating: params.min_rating,
            max_rating: params.max_rating,
            min_review_count: params.min_review_count,
            enrich: params.enrich,
            verify: params.verify,
          },
          forceRescrape: params.forceRescrape,
        };
      } else {
        body = params; // Trustpilot legacy shape — backend treats unset platform as trustpilot
      }
      const res = await api.post('/scrape', body);
      const id = res.data.data.jobId as string;
      // Refresh the jobs list FIRST so the new row (with platform/country/
      // category) is in `jobs[]` before the ActiveScrapeCard mounts. Without
      // this await, the card mounts with initialJob=null and the "From X"
      // label defaults to Trustpilot until the SSE 'current' event arrives
      // 1-2s later. Use try/finally so the card still mounts if the refresh
      // fails for any reason (silent — non-critical).
      try {
        await fetchJobs();
      } finally {
        setActiveScrapes((prev) => (prev.includes(id) ? prev : [...prev, id]));
      }
      return id;
    } catch (e: unknown) {
      const axiosMsg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(axiosMsg || (e instanceof Error ? e.message : 'Failed to start scrape'));
      return null;
    } finally {
      submittingRef.current = false;
    }
  }, [fetchJobs]);

  const dismissScrape = useCallback((id: string) => {
    setActiveScrapes((prev) => prev.filter((x) => x !== id));
  }, []);

  const cancelJob = useCallback(async (id: string) => {
    try {
      await api.post(`/scrape/${id}/cancel`);
      // Don't auto-dismiss the card — let the user see the cancelled state,
      // then click ✕ when they're ready.
      void fetchJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to cancel');
    }
  }, [fetchJobs]);

  const retryFailed = useCallback(async (id: string) => {
    try {
      const res = await api.post(`/scrape/${id}/retry-failed`);
      const retryJobId = res.data.data.retryJobId as string | undefined;
      if (retryJobId) {
        setActiveScrapes((prev) => (prev.includes(retryJobId) ? prev : [...prev, retryJobId]));
        void fetchJobs();
        return retryJobId;
      }
      return null;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to retry');
      return null;
    }
  }, [fetchJobs]);

  const deleteJob = useCallback(async (id: string) => {
    try {
      await api.delete(`/scrape/${id}`);
      setJobs((prev) => prev.filter((j) => j.id !== id));
      setActiveScrapes((prev) => prev.filter((x) => x !== id));
    } catch (e) {
      const axiosMsg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(axiosMsg || (e instanceof Error ? e.message : 'Failed to delete job'));
    }
  }, []);

  const cleanupEmptyJobs = useCallback(async () => {
    try {
      const res = await api.post('/scrape/cleanup-empty');
      const deletedCount: number = res.data.data.deletedCount ?? 0;
      const deletedIds = new Set<string>(
        (res.data.data.deleted || []).map((d: { id: string }) => d.id),
      );
      if (deletedCount > 0) {
        setJobs((prev) => prev.filter((j) => !deletedIds.has(j.id)));
        setActiveScrapes((prev) => prev.filter((x) => !deletedIds.has(x)));
      }
      return deletedCount;
    } catch (e) {
      const axiosMsg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(axiosMsg || (e instanceof Error ? e.message : 'Failed to clean up jobs'));
      return 0;
    }
  }, []);

  // Backward-compat shims for consumers that still read single-job fields
  // (Sidebar's "running" badge, etc.). `status='running'` when ANY active or
  // DB job is still running.
  const aggregateStatus: ScrapeJob['status'] | null = useMemo(() => {
    if (jobs.some((j) => j.status === 'running') || activeScrapes.length > 0) {
      // Active card list non-empty doesn't strictly mean "running" — a
      // dismissed-but-not-yet-removed card might be done — but the
      // jobs.some check above covers the real running condition.
      return jobs.some((j) => j.status === 'running') ? 'running' : null;
    }
    return null;
  }, [jobs, activeScrapes.length]);

  const value: ScrapeContextValue = {
    activeScrapes,
    jobs,
    jobsTotal,
    jobsPlatformFilter,
    setJobsPlatformFilter,
    jobsLoading,
    jobsPage,
    jobsPageSize: JOBS_PAGE_SIZE,
    setJobsPage,
    startScrape,
    dismissScrape,
    cancelJob,
    retryFailed,
    fetchJobs,
    deleteJob,
    cleanupEmptyJobs,

    // Compat shims
    jobId: activeScrapes[activeScrapes.length - 1] ?? null,
    status: aggregateStatus,
    progress: [],
    error,
    failedCount: 0,
  };

  return <ScrapeContext.Provider value={value}>{children}</ScrapeContext.Provider>;
}

export function useScrapeContext(): ScrapeContextValue {
  const ctx = useContext(ScrapeContext);
  if (!ctx) throw new Error('useScrapeContext must be used within ScrapeProvider');
  return ctx;
}

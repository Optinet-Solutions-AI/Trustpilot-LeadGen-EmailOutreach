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

export function ScrapeProvider({ children }: { children: ReactNode }) {
  const [activeScrapes, setActiveScrapes] = useState<string[]>([]);
  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
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

  const fetchJobs = useCallback(async () => {
    try {
      const res = await api.get('/scrape');
      const fetched = res.data.data as ScrapeJob[];
      setJobs(fetched);

      // Auto-promote any 'running' jobs from the DB into the card stack
      // if they aren't already tracked. Picks up jobs created by other tabs,
      // other users, or other workers (e.g. the EC2 worker claimed something
      // we didn't enqueue ourselves).
      const running = fetched.filter((j) => j.status === 'running').map((j) => j.id);
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
    }
  }, []);

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
      const res = await api.post('/scrape', params);
      const id = res.data.data.jobId as string;
      setActiveScrapes((prev) => (prev.includes(id) ? prev : [...prev, id]));
      // Refresh the jobs list so the new pending row shows up immediately
      void fetchJobs();
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

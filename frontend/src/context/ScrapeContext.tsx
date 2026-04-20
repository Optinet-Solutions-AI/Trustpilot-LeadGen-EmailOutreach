'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import api from '../api/client';
import type { ScrapeParams, ScrapeJob, ScrapeProgress } from '../types/scrape';

interface ScrapeContextValue {
  jobId: string | null;
  status: ScrapeJob['status'] | null;
  progress: ScrapeProgress[];
  error: string | null;
  jobs: ScrapeJob[];
  failedCount: number;
  startScrape: (params: ScrapeParams) => Promise<string | null>;
  cancelJob: (id: string) => Promise<void>;
  retryFailed: (id: string) => Promise<string | null>;
  fetchJobs: () => Promise<void>;
  deleteJob: (id: string) => Promise<void>;
  cleanupEmptyJobs: () => Promise<number>;
}

const ScrapeContext = createContext<ScrapeContextValue | null>(null);

const MAX_PROGRESS_ENTRIES = 200;
const POLL_INTERVAL_MS = 5000; // Poll every 5s as SSE safety net

export function ScrapeProvider({ children }: { children: ReactNode }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<ScrapeJob['status'] | null>(null);
  const [progress, setProgress] = useState<ScrapeProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const [failedCount, setFailedCount] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const statusRef = useRef<ScrapeJob['status'] | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep refs in sync
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { jobIdRef.current = jobId; }, [jobId]);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Mark job as done — update state, close SSE, stop polling, refresh jobs list
  const markDone = useCallback((newStatus: 'completed' | 'failed', errorMsg?: string) => {
    setStatus(newStatus);
    statusRef.current = newStatus;
    if (errorMsg) setError(errorMsg);
    closeEventSource();
    stopPolling();
    // Refresh jobs list to get final stats
    api.get('/scrape').then(res => {
      setJobs(res.data.data as ScrapeJob[]);
    }).catch(() => {});
  }, [closeEventSource, stopPolling]);

  // Poll the server for job status (safety net when SSE fails)
  const startPolling = useCallback((id: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      // Stop if no longer running
      if (statusRef.current !== 'running') {
        stopPolling();
        return;
      }
      try {
        const res = await api.get('/scrape');
        const fetched = res.data.data as ScrapeJob[];
        setJobs(fetched);
        const match = fetched.find((j: ScrapeJob) => j.id === id);
        if (match && match.status === 'completed') {
          markDone('completed');
        } else if (match && match.status === 'failed') {
          markDone('failed', match.error || 'Scrape failed');
        }
      } catch {
        // silent — will retry next interval
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling, markDone]);

  const subscribeToJob = useCallback((id: string, initialStatus?: ScrapeJob['status']) => {
    closeEventSource();
    stopPolling();
    setJobId(id);

    if (initialStatus === 'completed' || initialStatus === 'failed') {
      setStatus(initialStatus);
      return;
    }

    setStatus('running');

    // Start polling as safety net (catches completion if SSE misses it)
    startPolling(id);

    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '';
    const es = new EventSource(`${baseUrl}/api/scrape/${id}/status`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as ScrapeProgress & { status?: string };

      // 'current' is the initial snapshot sent by the server when we first connect
      if (data.stage === 'current') {
        const jobStatus = data.status as ScrapeJob['status'];
        if (jobStatus === 'completed') {
          markDone('completed');
        } else if (jobStatus === 'failed') {
          markDone('failed');
        }
        return;
      }

      // Track failed items
      if (data.stage === 'item_failed') {
        setFailedCount((prev) => prev + 1);
      }

      // Cap progress array to prevent unbounded growth
      setProgress((prev) => {
        const next = [...prev, data];
        return next.length > MAX_PROGRESS_ENTRIES
          ? next.slice(next.length - MAX_PROGRESS_ENTRIES)
          : next;
      });

      if (data.stage === 'completed') {
        markDone('completed');
      } else if (data.stage === 'failed') {
        markDone('failed', data.detail || 'Scrape failed');
      }
    };

    es.onerror = () => {
      const current = statusRef.current;
      if (current === 'completed' || current === 'failed') {
        closeEventSource();
        return;
      }
      // SSE disconnected while job was running — close SSE, let polling handle it
      closeEventSource();
    };
  }, [closeEventSource, stopPolling, startPolling, markDone]);

  const startScrape = useCallback(async (params: ScrapeParams) => {
    // Guard 1: block if a job is already running in this context
    if (statusRef.current === 'running') {
      setError('A scrape is already running. Wait for it to finish or cancel it first.');
      return null;
    }

    // Guard 2: check the jobs list for a running job with the same country+category
    const alreadyRunning = jobs.find(
      (j) => j.status === 'running' &&
        j.country === params.country &&
        j.category === params.category,
    );
    if (alreadyRunning && !params.forceRescrape) {
      setError(`A scrape for "${params.category}" in ${params.country} is already running (job ${alreadyRunning.id.slice(0, 8)}…).`);
      return null;
    }

    setError(null);
    setProgress([]);
    setFailedCount(0);
    try {
      const res = await api.post('/scrape', params);
      const id = res.data.data.jobId;
      // Persist so we can restore state after a page refresh
      localStorage.setItem('active_scrape_job', id);
      subscribeToJob(id);
      return id;
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      const axiosMsg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(axiosMsg || (e instanceof Error ? e.message : 'Failed to start scrape'));
      // 409 = duplicate detected by server — do NOT clobber the existing job status
      if (status !== 409) {
        setStatus('failed');
      }
      return null;
    }
  }, [subscribeToJob, jobs]);

  const cancelJob = useCallback(async (id: string) => {
    try {
      await api.post(`/scrape/${id}/cancel`);
      markDone('failed', 'Cancelled by user');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to cancel');
    }
  }, [markDone]);

  const retryFailed = useCallback(async (id: string) => {
    try {
      const res = await api.post(`/scrape/${id}/retry-failed`);
      const retryJobId = res.data.data.retryJobId;
      if (retryJobId) {
        setProgress([]);
        setFailedCount(0);
        setError(null);
        subscribeToJob(retryJobId);
        return retryJobId;
      }
      return null;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to retry');
      return null;
    }
  }, [subscribeToJob]);

  const deleteJob = useCallback(async (id: string) => {
    try {
      await api.delete(`/scrape/${id}`);
      setJobs((prev) => prev.filter((j) => j.id !== id));
      if (jobIdRef.current === id) {
        setJobId(null);
        jobIdRef.current = null;
        setStatus(null);
        statusRef.current = null;
        setProgress([]);
        setError(null);
        localStorage.removeItem('active_scrape_job');
      }
    } catch (e) {
      const axiosMsg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(axiosMsg || (e instanceof Error ? e.message : 'Failed to delete job'));
    }
  }, []);

  const cleanupEmptyJobs = useCallback(async () => {
    try {
      const res = await api.post('/scrape/cleanup-empty');
      const deletedCount: number = res.data.data.deletedCount ?? 0;
      const deletedIds = new Set<string>((res.data.data.deleted || []).map((d: { id: string }) => d.id));
      if (deletedCount > 0) {
        setJobs((prev) => prev.filter((j) => !deletedIds.has(j.id)));
        if (jobIdRef.current && deletedIds.has(jobIdRef.current)) {
          setJobId(null);
          jobIdRef.current = null;
          setStatus(null);
          statusRef.current = null;
          setProgress([]);
          setError(null);
          localStorage.removeItem('active_scrape_job');
        }
      }
      return deletedCount;
    } catch (e) {
      const axiosMsg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(axiosMsg || (e instanceof Error ? e.message : 'Failed to clean up jobs'));
      return 0;
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await api.get('/scrape');
      const fetched = res.data.data as ScrapeJob[];
      setJobs(fetched);

      // If no active job in state (e.g. after a page refresh), restore from DB
      if (!jobIdRef.current) {
        // Prefer the localStorage-persisted job; fall back to the most recent job
        const persistedId = localStorage.getItem('active_scrape_job');
        const target = (persistedId ? fetched.find((j) => j.id === persistedId) : null)
          ?? fetched[0];

        if (target) {
          setJobId(target.id);
          jobIdRef.current = target.id;
          // Restore terminal states immediately; 'running' falls through to auto-reconnect
          if (target.status === 'completed') {
            setStatus('completed');
            statusRef.current = 'completed';
          } else if (target.status === 'failed') {
            setStatus('failed');
            statusRef.current = 'failed';
            if (target.error) setError(target.error);
          }
        }
      }

      // Sync status from server for current job (catches completion while tab was inactive)
      const currentId = jobIdRef.current;
      if (currentId) {
        const match = fetched.find((j) => j.id === currentId);
        if (match && (match.status === 'completed' || match.status === 'failed')) {
          if (statusRef.current === 'running') {
            markDone(match.status as 'completed' | 'failed', match.error || undefined);
          }
        }
      }

      // Auto-reconnect if there's a running job and we have no active connection
      const alreadyConnected = eventSourceRef.current &&
        eventSourceRef.current.readyState !== EventSource.CLOSED;
      if (!alreadyConnected) {
        const running = fetched.find((j) => j.status === 'running');
        if (running) {
          setProgress([]);
          setFailedCount(0);
          subscribeToJob(running.id, 'running');
        }
      }
    } catch {
      // silent — jobs list is non-critical
    }
  }, [subscribeToJob, markDone]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      closeEventSource();
      stopPolling();
    };
  }, [closeEventSource, stopPolling]);

  return (
    <ScrapeContext.Provider value={{
      jobId, status, progress, error, jobs, failedCount,
      startScrape, cancelJob, retryFailed, fetchJobs, deleteJob, cleanupEmptyJobs,
    }}>
      {children}
    </ScrapeContext.Provider>
  );
}

export function useScrapeContext(): ScrapeContextValue {
  const ctx = useContext(ScrapeContext);
  if (!ctx) throw new Error('useScrapeContext must be used within ScrapeProvider');
  return ctx;
}

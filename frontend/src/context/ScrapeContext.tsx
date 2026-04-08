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
}

const ScrapeContext = createContext<ScrapeContextValue | null>(null);

const MAX_PROGRESS_ENTRIES = 200;

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

  // Keep refs in sync
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { jobIdRef.current = jobId; }, [jobId]);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // Silent fetch that doesn't trigger SSE reconnection (prevents loops)
  const fetchJobsSilent = useCallback(async () => {
    try {
      const res = await api.get('/scrape');
      const fetched = res.data.data as ScrapeJob[];
      setJobs(fetched);

      // Update status from server if our local job is in the list
      const currentId = jobIdRef.current;
      if (currentId) {
        const match = fetched.find((j) => j.id === currentId);
        if (match) {
          if (match.status === 'completed' || match.status === 'failed') {
            setStatus(match.status);
            statusRef.current = match.status;
            if (match.status === 'failed' && match.error) {
              setError(match.error);
            }
          }
        }
      }
    } catch {
      // silent
    }
  }, []);

  const subscribeToJob = useCallback((id: string, initialStatus?: ScrapeJob['status']) => {
    closeEventSource();
    setJobId(id);
    setStatus(initialStatus === 'completed' || initialStatus === 'failed' ? initialStatus : 'running');

    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '';
    const es = new EventSource(`${baseUrl}/api/scrape/${id}/status`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as ScrapeProgress & { status?: string };

      // 'current' is the initial snapshot sent by the server when we first connect
      if (data.stage === 'current') {
        const jobStatus = data.status as ScrapeJob['status'];
        if (jobStatus === 'completed') {
          setStatus('completed');
          closeEventSource();
          fetchJobsSilent();
        } else if (jobStatus === 'failed') {
          setStatus('failed');
          closeEventSource();
          fetchJobsSilent();
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
        setStatus('completed');
        closeEventSource();
        fetchJobsSilent();
      } else if (data.stage === 'failed') {
        setStatus('failed');
        setError(data.detail || 'Scrape failed');
        closeEventSource();
        fetchJobsSilent();
      }
    };

    es.onerror = () => {
      const current = statusRef.current;
      if (current === 'completed' || current === 'failed') {
        closeEventSource();
        return;
      }
      // SSE disconnected while job was running — poll server for actual status
      closeEventSource();
      setTimeout(() => {
        fetchJobsSilent();
      }, 2000);
    };
  }, [closeEventSource, fetchJobsSilent]);

  const startScrape = useCallback(async (params: ScrapeParams) => {
    setError(null);
    setProgress([]);
    setFailedCount(0);
    try {
      const res = await api.post('/scrape', params);
      const id = res.data.data.jobId;
      subscribeToJob(id);
      return id;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start scrape');
      setStatus('failed');
      return null;
    }
  }, [subscribeToJob]);

  const cancelJob = useCallback(async (id: string) => {
    try {
      await api.post(`/scrape/${id}/cancel`);
      setStatus('failed');
      setError('Cancelled by user');
      closeEventSource();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to cancel');
    }
  }, [closeEventSource]);

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

  const fetchJobs = useCallback(async () => {
    try {
      const res = await api.get('/scrape');
      const fetched = res.data.data as ScrapeJob[];
      setJobs(fetched);

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
  }, [subscribeToJob]);

  // Cleanup EventSource on unmount (app close only, not page navigation)
  useEffect(() => {
    return () => closeEventSource();
  }, [closeEventSource]);

  return (
    <ScrapeContext.Provider value={{
      jobId, status, progress, error, jobs, failedCount,
      startScrape, cancelJob, retryFailed, fetchJobs,
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

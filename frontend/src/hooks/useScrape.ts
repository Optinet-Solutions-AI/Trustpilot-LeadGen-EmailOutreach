import { useState, useCallback, useRef } from 'react';
import api from '../api/client';
import type { ScrapeParams, ScrapeJob, ScrapeProgress } from '../types/scrape';

export function useScrape() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<ScrapeJob['status'] | null>(null);
  const [progress, setProgress] = useState<ScrapeProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  const subscribeToJob = useCallback((id: string, initialStatus?: ScrapeJob['status']) => {
    // Close any existing connection
    eventSourceRef.current?.close();
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
        if (jobStatus === 'completed') { setStatus('completed'); es.close(); }
        else if (jobStatus === 'failed') { setStatus('failed'); es.close(); }
        // still running — keep listening
        return;
      }

      setProgress((prev) => [...prev, data]);
      if (data.stage === 'completed') {
        setStatus('completed');
        es.close();
      } else if (data.stage === 'failed') {
        setStatus('failed');
        setError(data.detail || 'Scrape failed');
        es.close();
      }
    };

    es.onerror = () => {
      // EventSource auto-retries; only close if we know the job ended
      if (status === 'completed' || status === 'failed') es.close();
    };
  }, [status]);

  const startScrape = useCallback(async (params: ScrapeParams) => {
    setError(null);
    setProgress([]);
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
          subscribeToJob(running.id, 'running');
        }
      }
    } catch {
      // silent
    }
  }, [subscribeToJob]);

  const stopListening = useCallback(() => {
    eventSourceRef.current?.close();
  }, []);

  return { jobId, status, progress, error, jobs, startScrape, fetchJobs, stopListening };
}

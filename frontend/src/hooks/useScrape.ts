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

  const startScrape = useCallback(async (params: ScrapeParams) => {
    setError(null);
    setProgress([]);
    try {
      const res = await api.post('/scrape', params);
      const id = res.data.data.jobId;
      setJobId(id);
      setStatus('running');

      // Subscribe to SSE progress
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '';
      const es = new EventSource(`${baseUrl}/api/scrape/${id}/status`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        const data = JSON.parse(event.data) as ScrapeProgress & { status?: string };
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
        es.close();
      };

      return id;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start scrape');
      setStatus('failed');
      return null;
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await api.get('/scrape');
      setJobs(res.data.data);
    } catch {
      // silent
    }
  }, []);

  const stopListening = useCallback(() => {
    eventSourceRef.current?.close();
  }, []);

  return { jobId, status, progress, error, jobs, startScrape, fetchJobs, stopListening };
}

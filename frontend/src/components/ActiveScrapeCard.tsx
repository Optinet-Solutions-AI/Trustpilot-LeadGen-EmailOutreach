'use client';

/**
 * Self-contained progress card for a single in-flight scrape.
 *
 * Each card opens its own SSE connection to /api/scrape/:id/status and
 * renders the JobProgress component. Multiple cards stack on the Scrape
 * page so the user can start up to MAX_CONCURRENT_JOBS scrapes (3 on EC2)
 * and watch all of them live. Each card has its own cancel + dismiss.
 */

import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import JobProgress from './JobProgress';
import type { ScrapeJob, ScrapeProgress } from '../types/scrape';

interface Props {
  jobId: string;
  initialJob?: ScrapeJob | null;
  onDismiss: () => void;
}

const MAX_PROGRESS_ENTRIES = 200;
const POLL_INTERVAL_MS = 5000;

export default function ActiveScrapeCard({ jobId, initialJob, onDismiss }: Props) {
  const [status, setStatus] = useState<ScrapeJob['status']>(initialJob?.status ?? 'running');
  const [progress, setProgress] = useState<ScrapeProgress[]>([]);
  const [error, setError] = useState<string | null>(initialJob?.error ?? null);
  const [failedCount, setFailedCount] = useState(0);
  const [liveJob, setLiveJob] = useState<{ total_found: number; total_scraped: number } | null>(
    initialJob ? { total_found: initialJob.total_found ?? 0, total_scraped: initialJob.total_scraped ?? 0 } : null,
  );
  const [startedAt, setStartedAt] = useState<string | null>(initialJob?.started_at ?? null);
  const [completedAt, setCompletedAt] = useState<string | null>(initialJob?.completed_at ?? null);
  const [country, setCountry] = useState<string>(initialJob?.country ?? '');
  const [category, setCategory] = useState<string>(initialJob?.category ?? '');

  const statusRef = useRef<ScrapeJob['status']>(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  // Open SSE + start polling fallback
  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '';
    const es = new EventSource(`${baseUrl}/api/scrape/${jobId}/status`);

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as ScrapeProgress & { status?: string; country?: string; category?: string; started_at?: string; completed_at?: string };

      if (data.stage === 'current') {
        const jobStatus = data.status as ScrapeJob['status'];
        if (data.country) setCountry(data.country);
        if (data.category) setCategory(data.category);
        if (data.started_at) setStartedAt(data.started_at);
        if (data.completed_at) setCompletedAt(data.completed_at);
        if (jobStatus === 'completed' || jobStatus === 'failed') {
          setStatus(jobStatus);
          es.close();
        }
        return;
      }

      if (data.stage === 'item_failed') {
        setFailedCount((c) => c + 1);
      }

      setProgress((prev) => {
        const next = [...prev, data];
        return next.length > MAX_PROGRESS_ENTRIES ? next.slice(-MAX_PROGRESS_ENTRIES) : next;
      });

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
      // Don't bail — let polling take over. EventSource will keep retrying on its own.
      // We only force-close on terminal status.
    };

    // Safety-net polling: catches DB-completion that SSE missed (e.g. SSE dropped while tab was inactive)
    const poll = setInterval(async () => {
      if (statusRef.current !== 'running') return;
      try {
        const res = await api.get('/scrape');
        const jobs = res.data.data as ScrapeJob[];
        const j = jobs.find((row) => row.id === jobId);
        if (!j) return;
        if (j.country && !country) setCountry(j.country);
        if (j.category && !category) setCategory(j.category);
        if (j.started_at && !startedAt) setStartedAt(j.started_at);
        setLiveJob({ total_found: j.total_found ?? 0, total_scraped: j.total_scraped ?? 0 });
        if (j.status === 'completed' || j.status === 'failed') {
          setStatus(j.status);
          if (j.completed_at) setCompletedAt(j.completed_at);
          if (j.error) setError(j.error);
          es.close();
        }
      } catch {
        // silent
      }
    }, POLL_INTERVAL_MS);

    return () => {
      es.close();
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const onCancel = async () => {
    try {
      await api.post(`/scrape/${jobId}/cancel`);
      setStatus('failed');
      setError((prev) => prev ?? 'Cancelled by user');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancel failed');
    }
  };

  const isTerminal = status === 'completed' || status === 'failed';

  return (
    <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6 sm:p-8 relative">
      <div className="flex items-start justify-between mb-4 gap-4">
        <div className="min-w-0">
          <h3
            className="text-lg font-bold text-on-surface truncate"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Scrape Progress
            {(country || category) && (
              <span className="ml-2 text-secondary font-medium text-base">
                · {category} {country && `— ${country}`}
              </span>
            )}
          </h3>
          <p className="text-xs text-secondary mt-1 font-mono">
            {jobId.slice(0, 8)}…
          </p>
        </div>
        {isTerminal && (
          <button
            onClick={onDismiss}
            className="flex items-center justify-center w-8 h-8 rounded-lg text-secondary hover:bg-surface-container hover:text-on-surface transition-colors flex-shrink-0"
            aria-label="Dismiss this scrape"
            title="Dismiss"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        )}
      </div>
      <JobProgress
        kind="scrape"
        status={status as 'running' | 'completed' | 'failed' | null}
        progress={progress}
        error={error}
        failedCount={failedCount}
        liveJob={liveJob}
        startedAt={startedAt}
        completedAt={completedAt}
        onCancel={status === 'running' ? onCancel : undefined}
      />
    </div>
  );
}

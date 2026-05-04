'use client';

import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import type { ScrapeProgress } from '../types/scrape';

export type CheckLinksJobStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface CheckLinksJobState {
  status: CheckLinksJobStatus;
  progress: ScrapeProgress[];
  summary: {
    total: number;
    checked: number;
    valid: number;
    flagged_dead: number;
    flagged_removed: number;
    unknown: number;
  };
  error: string | null;
}

const MAX_PROGRESS_ENTRIES = 200;
const POLL_INTERVAL_MS = 5000;

const EMPTY_SUMMARY = { total: 0, checked: 0, valid: 0, flagged_dead: 0, flagged_removed: 0, unknown: 0 };

// Listens to the SSE stream (or falls back to polling) for a check-links job.
// Mirrors useVerifyJob — same shape so JobProgress can render either kind.
// `source` selects which backend route to subscribe to: leads or affiliates.
export function useCheckLinksJob(jobId: string | null, source: 'leads' | 'affiliates'): CheckLinksJobState {
  const [state, setState] = useState<CheckLinksJobState>({
    status: jobId ? 'running' : 'idle',
    progress: [],
    summary: { ...EMPTY_SUMMARY },
    error: null,
  });

  const statusRef = useRef<CheckLinksJobStatus>(state.status);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Cloud Run runs the API on multiple instances and the job registry is
  // in-memory per instance — polling can hit a different instance than the
  // POST and get 404. Don't treat that as completion until we've seen several
  // 404s in a row, so a transient instance-routing flap can self-heal.
  const missCountRef = useRef(0);
  const MAX_404_RETRIES = 4;

  useEffect(() => { statusRef.current = state.status; }, [state.status]);

  useEffect(() => {
    if (!jobId) {
      setState({ status: 'idle', progress: [], summary: { ...EMPTY_SUMMARY }, error: null });
      return;
    }

    setState({ status: 'running', progress: [], summary: { ...EMPTY_SUMMARY }, error: null });
    statusRef.current = 'running';

    const cleanup = () => {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };

    const markDone = (status: 'completed' | 'failed', errorMsg?: string) => {
      statusRef.current = status;
      setState((prev) => ({ ...prev, status, ...(errorMsg ? { error: errorMsg } : {}) }));
      cleanup();
    };

    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '';
    const es = new EventSource(`${baseUrl}/api/${source}/check-links/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as ScrapeProgress & {
        status?: string;
        total?: number;
        checked?: number;
        valid?: number;
        flagged_dead?: number;
        flagged_removed?: number;
        unknown?: number;
      };

      if (data.stage === 'current') {
        setState((prev) => ({
          ...prev,
          summary: {
            total: data.total ?? prev.summary.total,
            checked: data.checked ?? prev.summary.checked,
            valid: data.valid ?? prev.summary.valid,
            flagged_dead: data.flagged_dead ?? prev.summary.flagged_dead,
            flagged_removed: data.flagged_removed ?? prev.summary.flagged_removed,
            unknown: data.unknown ?? prev.summary.unknown,
          },
        }));
        if (data.status === 'completed') markDone('completed');
        else if (data.status === 'failed') markDone('failed');
        return;
      }

      setState((prev) => {
        const nextProgress = [...prev.progress, data];
        const trimmed = nextProgress.length > MAX_PROGRESS_ENTRIES
          ? nextProgress.slice(nextProgress.length - MAX_PROGRESS_ENTRIES)
          : nextProgress;

        if (data.stage === 'completed') {
          try {
            const m = JSON.parse(data.detail || '{}') as Partial<CheckLinksJobState['summary']>;
            return {
              ...prev,
              progress: trimmed,
              summary: {
                total: m.total ?? prev.summary.total,
                checked: m.checked ?? prev.summary.checked,
                valid: m.valid ?? prev.summary.valid,
                flagged_dead: m.flagged_dead ?? prev.summary.flagged_dead,
                flagged_removed: m.flagged_removed ?? prev.summary.flagged_removed,
                unknown: m.unknown ?? prev.summary.unknown,
              },
            };
          } catch { /* keep existing summary */ }
        }
        return { ...prev, progress: trimmed };
      });

      if (data.stage === 'completed') markDone('completed');
      else if (data.stage === 'failed') markDone('failed', data.detail || 'Link check failed');
    };

    es.onerror = () => { es.close(); esRef.current = null; };

    const poll = async () => {
      if (statusRef.current !== 'running') return;
      try {
        const res = await api.get(`/${source}/check-links/status?jobId=${jobId}`);
        missCountRef.current = 0;
        const d = res.data.data as {
          status: 'running' | 'done' | 'failed';
          total: number;
          checked: number;
          valid: number;
          flagged_dead: number;
          flagged_removed: number;
          unknown: number;
          error?: string;
        };
        setState((prev) => ({
          ...prev,
          summary: {
            total: d.total,
            checked: d.checked,
            valid: d.valid,
            flagged_dead: d.flagged_dead,
            flagged_removed: d.flagged_removed,
            unknown: d.unknown,
          },
        }));
        if (d.status === 'done') markDone('completed');
        else if (d.status === 'failed') markDone('failed', d.error || 'Link check failed');
      } catch (err: unknown) {
        const httpStatus = (err as { response?: { status?: number } })?.response?.status;
        if (httpStatus === 404) {
          missCountRef.current += 1;
          if (missCountRef.current >= MAX_404_RETRIES) {
            markDone('failed', 'Job not found — try again');
          }
        }
      }
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return cleanup;
  }, [jobId, source]);

  return state;
}

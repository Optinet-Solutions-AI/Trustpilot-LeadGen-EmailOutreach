'use client';

import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import type { ScrapeProgress } from '../types/scrape';

export type CheckClaimedJobStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface CheckClaimedJobState {
  status: CheckClaimedJobStatus;
  progress: ScrapeProgress[];
  summary: {
    total: number;
    checked: number;
    claimed: number;
    unclaimed: number;
    unknown: number;
  };
  error: string | null;
}

const MAX_PROGRESS_ENTRIES = 200;
const POLL_INTERVAL_MS = 5000;

const EMPTY_SUMMARY = { total: 0, checked: 0, claimed: 0, unclaimed: 0, unknown: 0 };

// Listens to the SSE stream (or falls back to polling) for a check-claimed job.
// Mirrors useCheckLinksJob — same shape so JobProgress can render either kind.
// Auto-resumes on mount if jobId is non-null (e.g. restored from localStorage).
export function useCheckClaimedJob(jobId: string | null): CheckClaimedJobState {
  const [state, setState] = useState<CheckClaimedJobState>({
    status: jobId ? 'running' : 'idle',
    progress: [],
    summary: { ...EMPTY_SUMMARY },
    error: null,
  });

  const statusRef = useRef<CheckClaimedJobStatus>(state.status);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    const es = new EventSource(`${baseUrl}/api/leads/check-claimed/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as ScrapeProgress & {
        status?: string;
        total?: number;
        checked?: number;
        claimed?: number;
        unclaimed?: number;
        unknown?: number;
      };

      if (data.stage === 'current') {
        setState((prev) => ({
          ...prev,
          summary: {
            total: data.total ?? prev.summary.total,
            checked: data.checked ?? prev.summary.checked,
            claimed: data.claimed ?? prev.summary.claimed,
            unclaimed: data.unclaimed ?? prev.summary.unclaimed,
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
            const m = JSON.parse(data.detail || '{}') as Partial<CheckClaimedJobState['summary']>;
            return {
              ...prev,
              progress: trimmed,
              summary: {
                total: m.total ?? prev.summary.total,
                checked: m.checked ?? prev.summary.checked,
                claimed: m.claimed ?? prev.summary.claimed,
                unclaimed: m.unclaimed ?? prev.summary.unclaimed,
                unknown: m.unknown ?? prev.summary.unknown,
              },
            };
          } catch { /* keep existing summary */ }
        }
        return { ...prev, progress: trimmed };
      });

      if (data.stage === 'completed') markDone('completed');
      else if (data.stage === 'failed') markDone('failed', data.detail || 'Claimed check failed');
    };

    es.onerror = () => { es.close(); esRef.current = null; };

    const poll = async () => {
      if (statusRef.current !== 'running') return;
      try {
        const res = await api.get(`/leads/check-claimed/status?jobId=${jobId}`);
        const d = res.data.data as {
          status: 'running' | 'done' | 'failed';
          total: number;
          checked: number;
          claimed: number;
          unclaimed: number;
          unknown: number;
          error?: string;
        };
        setState((prev) => ({
          ...prev,
          summary: {
            total: d.total,
            checked: d.checked,
            claimed: d.claimed,
            unclaimed: d.unclaimed,
            unknown: d.unknown,
          },
        }));
        if (d.status === 'done') markDone('completed');
        else if (d.status === 'failed') markDone('failed', d.error || 'Claimed check failed');
      } catch (err: unknown) {
        const httpStatus = (err as { response?: { status?: number } })?.response?.status;
        if (httpStatus === 404) markDone('completed');
      }
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return cleanup;
  }, [jobId]);

  return state;
}

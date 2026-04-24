'use client';

import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import type { ScrapeProgress } from '../types/scrape';

export type VerifyJobStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface VerifyJobState {
  status: VerifyJobStatus;
  progress: ScrapeProgress[];
  summary: {
    total: number;
    verified: number;
    invalid: number;
    catchAll: number;
    unknown: number;
  };
  error: string | null;
}

const MAX_PROGRESS_ENTRIES = 200;
const POLL_INTERVAL_MS = 5000;

export function useVerifyJob(jobId: string | null): VerifyJobState {
  const [state, setState] = useState<VerifyJobState>({
    status: jobId ? 'running' : 'idle',
    progress: [],
    summary: { total: 0, verified: 0, invalid: 0, catchAll: 0, unknown: 0 },
    error: null,
  });

  const statusRef = useRef<VerifyJobStatus>(state.status);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { statusRef.current = state.status; }, [state.status]);

  useEffect(() => {
    if (!jobId) {
      setState({ status: 'idle', progress: [], summary: { total: 0, verified: 0, invalid: 0, catchAll: 0, unknown: 0 }, error: null });
      return;
    }

    setState({ status: 'running', progress: [], summary: { total: 0, verified: 0, invalid: 0, catchAll: 0, unknown: 0 }, error: null });
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
    const es = new EventSource(`${baseUrl}/api/verify/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as ScrapeProgress & {
        status?: string;
        total?: number;
        verified?: number;
        invalid?: number;
        catchAll?: number;
        unknown?: number;
      };

      if (data.stage === 'current') {
        // Snapshot spreads the whole job object — read counters here so we don't
        // lose final values when the job completes before SSE connects.
        setState((prev) => ({
          ...prev,
          summary: {
            total: data.total ?? prev.summary.total,
            verified: data.verified ?? prev.summary.verified,
            invalid: data.invalid ?? prev.summary.invalid,
            catchAll: data.catchAll ?? prev.summary.catchAll,
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
            const m = JSON.parse(data.detail || '{}') as {
              total?: number;
              verified?: number;
              invalid?: number;
              catchAll?: number;
              unknown?: number;
            };
            return {
              ...prev,
              progress: trimmed,
              summary: {
                total: m.total ?? prev.summary.total,
                verified: m.verified ?? prev.summary.verified,
                invalid: m.invalid ?? prev.summary.invalid,
                catchAll: m.catchAll ?? prev.summary.catchAll,
                unknown: m.unknown ?? prev.summary.unknown,
              },
            };
          } catch { /* keep existing summary */ }
        }
        return { ...prev, progress: trimmed };
      });

      if (data.stage === 'completed') markDone('completed');
      else if (data.stage === 'failed') markDone('failed', data.detail || 'Verification failed');
    };

    es.onerror = () => { es.close(); esRef.current = null; };

    const poll = async () => {
      if (statusRef.current !== 'running') return;
      try {
        const res = await api.get(`/verify/status?jobId=${jobId}`);
        const d = res.data.data as {
          status: 'running' | 'done' | 'failed';
          total: number;
          verified: number;
          invalid: number;
          catchAll: number;
          unknown: number;
          error?: string;
        };
        setState((prev) => ({
          ...prev,
          summary: { total: d.total, verified: d.verified, invalid: d.invalid, catchAll: d.catchAll, unknown: d.unknown },
        }));
        if (d.status === 'done') markDone('completed');
        else if (d.status === 'failed') markDone('failed', d.error || 'Verification failed');
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

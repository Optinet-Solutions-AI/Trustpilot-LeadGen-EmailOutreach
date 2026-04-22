'use client';

import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import type { ScrapeProgress } from '../types/scrape';

export type EnrichJobStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface EnrichJobState {
  status: EnrichJobStatus;
  progress: ScrapeProgress[];
  summary: {
    total: number;
    found: number;
    failed: number;
  };
  error: string | null;
}

const MAX_PROGRESS_ENTRIES = 200;
const POLL_INTERVAL_MS = 5000;

/**
 * Subscribe to an enrichment job's live events. Mirrors the scrape context's
 * SSE+polling pattern so the same log panel works for enrichment on the Leads
 * page. When the server-sent events drop, polling against /enrich/status
 * still catches completion and keeps the UI honest.
 *
 * Returns idle state when jobId is null.
 */
export function useEnrichJob(jobId: string | null): EnrichJobState {
  const [state, setState] = useState<EnrichJobState>({
    status: jobId ? 'running' : 'idle',
    progress: [],
    summary: { total: 0, found: 0, failed: 0 },
    error: null,
  });

  const statusRef = useRef<EnrichJobStatus>(state.status);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  useEffect(() => {
    if (!jobId) {
      setState({
        status: 'idle',
        progress: [],
        summary: { total: 0, found: 0, failed: 0 },
        error: null,
      });
      return;
    }

    // Reset state whenever we subscribe to a new job
    setState({
      status: 'running',
      progress: [],
      summary: { total: 0, found: 0, failed: 0 },
      error: null,
    });
    statusRef.current = 'running';

    const cleanup = () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const markDone = (status: 'completed' | 'failed', errorMsg?: string) => {
      statusRef.current = status;
      setState((prev) => ({
        ...prev,
        status,
        ...(errorMsg ? { error: errorMsg } : {}),
      }));
      cleanup();
    };

    // ── SSE stream ───────────────────────────────────────────────────────────
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '';
    const es = new EventSource(`${baseUrl}/api/enrich/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as ScrapeProgress & { status?: string };

      if (data.stage === 'current') {
        const jobStatus = data.status as EnrichJobStatus;
        if (jobStatus === 'completed') markDone('completed');
        else if (jobStatus === 'failed') markDone('failed');
        return;
      }

      setState((prev) => {
        const nextProgress = [...prev.progress, data];
        const trimmed = nextProgress.length > MAX_PROGRESS_ENTRIES
          ? nextProgress.slice(nextProgress.length - MAX_PROGRESS_ENTRIES)
          : nextProgress;
        // Fold the `completed` event's JSON detail into summary — otherwise the
        // post-completion banner reads from the last poll snapshot (often zero,
        // since polling stops as soon as SSE says done).
        if (data.stage === 'completed') {
          try {
            const finalCounts = JSON.parse(data.detail || '{}') as {
              totalFound?: number;
              saved?: number;
              enriched?: number;
              failed?: number;
            };
            return {
              ...prev,
              progress: trimmed,
              summary: {
                total: finalCounts.totalFound ?? prev.summary.total,
                found: finalCounts.enriched ?? finalCounts.saved ?? prev.summary.found,
                failed: finalCounts.failed ?? prev.summary.failed,
              },
            };
          } catch {
            // detail wasn't JSON — keep the polled summary
          }
        }
        return { ...prev, progress: trimmed };
      });

      if (data.stage === 'completed') markDone('completed');
      else if (data.stage === 'failed') markDone('failed', data.detail || 'Enrichment failed');
    };

    es.onerror = () => {
      // SSE dropped — lean on polling. No error surface yet; polling will
      // either catch completion or detect a terminal state.
      es.close();
      esRef.current = null;
    };

    // ── Polling safety net ──────────────────────────────────────────────────
    const poll = async () => {
      if (statusRef.current !== 'running') return;
      try {
        const res = await api.get(`/enrich/status?jobId=${jobId}`);
        const d = res.data.data as {
          status: 'running' | 'done' | 'failed';
          total: number;
          found: number;
          failed: number;
          error?: string;
        };
        setState((prev) => ({
          ...prev,
          summary: { total: d.total, found: d.found, failed: d.failed },
        }));
        if (d.status === 'done') markDone('completed');
        else if (d.status === 'failed') markDone('failed', d.error || 'Enrichment failed');
      } catch (err: unknown) {
        const httpStatus = (err as { response?: { status?: number } })?.response?.status;
        if (httpStatus === 404) {
          // Stale id — job was cleaned up. Treat as completed to dismiss the panel.
          markDone('completed');
        }
      }
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return cleanup;
  }, [jobId]);

  return state;
}

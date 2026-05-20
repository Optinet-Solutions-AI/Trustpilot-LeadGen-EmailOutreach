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
  /** True when status is still 'running' but we haven't seen activity in
   *  STALL_THRESHOLD_MS — the backend died (deploy SIGTERM, OOM, etc.)
   *  and the orphan reaper hasn't flipped the row yet. Surfacing this
   *  in the UI prevents the widget from looking frozen-but-fine. */
  stalled: boolean;
}

const MAX_PROGRESS_ENTRIES = 200;
const POLL_INTERVAL_MS = 5000;
// Worker heartbeats every ~20s; ANY heartbeat newer than this means the
// backend is alive — even if a slow website has held the enricher for a
// minute with no counter movement. Counter changes also still count as
// activity (they bump the same timestamp on the poll path).
// Raised from 90s after 2026-05-20 incident where a 1m51s-into-the-job
// poll showed "stuck" while the enricher was actually still working its
// way through a slow-loading website (the job went on to finish 6 min
// later with 18/20 enriched).
const STALL_THRESHOLD_MS = 180_000;
const STALL_CHECK_INTERVAL_MS = 5_000;

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
    stalled: false,
  });

  const statusRef = useRef<EnrichJobStatus>(state.status);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Cloud Run runs the API on multiple instances and the job registry is
  // in-memory per instance — polling can hit a different instance than the
  // POST and get 404. Don't treat that as completion until we've seen several
  // 404s in a row, so a transient instance-routing flap can self-heal.
  const missCountRef = useRef(0);
  const MAX_404_RETRIES = 4;
  // Stall detection: bumped on every SSE event or poll showing changed
  // counters; checked on a 5s interval while running.
  const lastActivityRef = useRef<number>(Date.now());
  const stallTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSummaryRef = useRef<{ total: number; found: number; failed: number }>({ total: 0, found: 0, failed: 0 });

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
        stalled: false,
      });
      return;
    }

    // Reset state whenever we subscribe to a new job
    setState({
      status: 'running',
      progress: [],
      summary: { total: 0, found: 0, failed: 0 },
      error: null,
      stalled: false,
    });
    statusRef.current = 'running';
    lastActivityRef.current = Date.now();
    lastSummaryRef.current = { total: 0, found: 0, failed: 0 };

    const cleanup = () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (stallTimerRef.current) {
        clearInterval(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    };

    const bumpActivity = () => {
      lastActivityRef.current = Date.now();
      // If we were marked stalled, clear it now that activity is back
      setState((prev) => prev.stalled ? { ...prev, stalled: false } : prev);
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
      bumpActivity();
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
        missCountRef.current = 0;
        const d = res.data.data as {
          status: 'running' | 'done' | 'failed';
          total: number;
          found: number;
          failed: number;
          error?: string;
          last_heartbeat_at?: string | null;
        };
        // Liveness: prefer the worker's heartbeat (refreshed ~every 20s on
        // the running job) over counter changes. A counter-change-only
        // signal flags a healthy enricher as "stuck" when a single slow
        // website blocks the queue for 60-90s. Heartbeat means: "the
        // process is alive and processing", which is what we actually want
        // to know. Counter changes still count as activity too (covers a
        // rare case where heartbeat is delayed but progress is happening).
        const last = lastSummaryRef.current;
        const heartbeatAge = d.last_heartbeat_at
          ? Date.now() - new Date(d.last_heartbeat_at).getTime()
          : Number.POSITIVE_INFINITY;
        const counterChanged =
          d.total !== last.total || d.found !== last.found || d.failed !== last.failed;
        if (counterChanged || heartbeatAge < STALL_THRESHOLD_MS) {
          bumpActivity();
          if (counterChanged) {
            lastSummaryRef.current = { total: d.total, found: d.found, failed: d.failed };
          }
        }
        setState((prev) => ({
          ...prev,
          summary: { total: d.total, found: d.found, failed: d.failed },
        }));
        if (d.status === 'done') markDone('completed');
        else if (d.status === 'failed') markDone('failed', d.error || 'Enrichment failed');
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

    // Stall detector — flips state.stalled = true once activity has been
    // silent past the threshold while we still think the job is running.
    stallTimerRef.current = setInterval(() => {
      if (statusRef.current !== 'running') return;
      const silentMs = Date.now() - lastActivityRef.current;
      if (silentMs >= STALL_THRESHOLD_MS) {
        setState((prev) => prev.stalled ? prev : { ...prev, stalled: true });
      }
    }, STALL_CHECK_INTERVAL_MS);

    return cleanup;
  }, [jobId]);

  return state;
}

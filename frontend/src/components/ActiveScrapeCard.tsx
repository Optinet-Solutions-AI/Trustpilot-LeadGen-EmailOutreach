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

/**
 * Merge persisted recent_events (from scrape_jobs.recent_events,
 * migration 042) into the local SSE-style progress buffer. Deduped by
 * `(stage, timestamp)` so the same event re-applied across polls
 * doesn't compound. Result is sorted oldest-to-newest so JobProgress
 * renders the Live Activity feed chronologically.
 */
function mergeProgress(
  prev: ScrapeProgress[],
  incoming: Array<{ stage: string; detail: string; ts: string }>,
  jobId: string,
): ScrapeProgress[] {
  const seen = new Set(prev.map((p) => `${p.stage}|${p.timestamp ?? ''}`));
  const additions: ScrapeProgress[] = [];
  for (const ev of incoming) {
    const key = `${ev.stage}|${ev.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({ jobId, stage: ev.stage, detail: ev.detail, timestamp: ev.ts });
  }
  if (additions.length === 0) return prev;
  const merged = [...prev, ...additions].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });
  // Cap at MAX_PROGRESS_ENTRIES so a long-running scrape doesn't grow the
  // array indefinitely — keep the newest tail.
  return merged.length > MAX_PROGRESS_ENTRIES
    ? merged.slice(merged.length - MAX_PROGRESS_ENTRIES)
    : merged;
}

// Auto-dismiss finished cards so the page doesn't pile up old results. The
// job still lives in the Recent Jobs table below — only the live card goes.
const AUTO_DISMISS_MS = 60_000;

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
  // For non-Trustpilot platforms the top-level country/category columns
  // hold placeholders ('_yelp_' / 'all'), and the authoritative values
  // live in `filters` jsonb. Pick the real ones for display.
  const initialFiltersCountry = (initialJob?.filters as { country?: string } | null | undefined)?.country;
  const initialFiltersCategory = (initialJob?.filters as { category?: string } | null | undefined)?.category;
  const initialCountry =
    initialJob?.country && !initialJob.country.startsWith('_')
      ? initialJob.country
      : initialFiltersCountry ?? initialJob?.country ?? '';
  const initialCategory =
    initialJob?.category && initialJob.category !== 'all'
      ? initialJob.category
      : initialFiltersCategory ?? initialJob?.category ?? '';

  const [country, setCountry] = useState<string>(initialCountry);
  const [category, setCategory] = useState<string>(initialCategory);
  const [platform, setPlatform] = useState<string | undefined>(initialJob?.platform);

  const statusRef = useRef<ScrapeJob['status']>(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  // Hydrate state from initialJob whenever it changes from null to a
  // populated row. Without this, a card mounted before fetchJobs() resolved
  // would stay with platform=undefined and the JobProgress label would
  // default to "From Trustpilot" even on Yelp / TripAdvisor scrapes until
  // the SSE 'current' event eventually arrives. Only fields that are still
  // empty/default get overwritten, so we don't clobber live SSE updates.
  useEffect(() => {
    if (!initialJob) return;
    if (initialJob.platform && !platform) setPlatform(initialJob.platform);
    // Same filters-aware fallback as the initial useState init.
    const f = initialJob.filters as { country?: string; category?: string } | null | undefined;
    const realCountry =
      initialJob.country && !initialJob.country.startsWith('_')
        ? initialJob.country
        : f?.country ?? initialJob.country;
    const realCategory =
      initialJob.category && initialJob.category !== 'all'
        ? initialJob.category
        : f?.category ?? initialJob.category;
    if (realCountry && !country) setCountry(realCountry);
    if (realCategory && !category) setCategory(realCategory);
    if (initialJob.started_at && !startedAt) setStartedAt(initialJob.started_at);
    if (initialJob.completed_at && !completedAt) setCompletedAt(initialJob.completed_at);
    // Hydrate counters too. When fetchJobs() resolves after the card
    // mounted (or after the page was refreshed mid-scrape), liveJob
    // stays at 0/0 because nothing else seeds it post-mount. Without
    // this, a completed FB scrape with total_found=33 / total_scraped=29
    // displayed as "Companies Found: 0" on refresh until the operator
    // pressed F5 again. Always trust the DB row when we have one.
    if (initialJob.total_found != null || initialJob.total_scraped != null) {
      setLiveJob({
        total_found: initialJob.total_found ?? 0,
        total_scraped: initialJob.total_scraped ?? 0,
      });
    }
    // Hydrate the progress feed from the persisted recent_events ring
    // buffer (migration 042). Cloud Run / API Gateway swallows SSE, so
    // these events are the ONLY way the deployed Live Activity panel
    // populates. Re-applied on each initialJob change so a poll-driven
    // jobs refresh continues to top up the panel.
    const recent = (initialJob as { recent_events?: Array<{ stage: string; detail: string; ts: string }> }).recent_events;
    if (recent && Array.isArray(recent) && recent.length > 0) {
      setProgress((prev) => mergeProgress(prev, recent, jobId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJob?.id, initialJob?.platform, initialJob?.country, initialJob?.category, initialJob?.total_found, initialJob?.total_scraped, initialJob?.recent_events]);

  // Open SSE + start polling fallback
  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || '';
    const es = new EventSource(`${baseUrl}/api/scrape/${jobId}/status`);

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as ScrapeProgress & {
        status?: string;
        platform?: string;
        country?: string;
        category?: string;
        filters?: { country?: string; category?: string } | null;
        started_at?: string;
        completed_at?: string;
      };

      if (data.stage === 'current') {
        const jobStatus = data.status as ScrapeJob['status'];
        if (data.platform) setPlatform(data.platform);
        // Same filters-aware fallback so we never show '_yelp_' / 'all'.
        const realCountry =
          data.country && !data.country.startsWith('_')
            ? data.country
            : data.filters?.country ?? data.country;
        const realCategory =
          data.category && data.category !== 'all'
            ? data.category
            : data.filters?.category ?? data.category;
        if (realCountry) setCountry(realCountry);
        if (realCategory) setCategory(realCategory);
        if (data.started_at) setStartedAt(data.started_at);
        if (data.completed_at) setCompletedAt(data.completed_at);
        // Track pending → running too. Without this, an EC2-claimed job
        // would stay visually 'pending' until terminal, because the
        // EventEmitter on this API instance never fires (the worker
        // lives in a different process).
        if (jobStatus) setStatus(jobStatus);
        if (jobStatus === 'completed' || jobStatus === 'failed') {
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
      } else if (data.stage === 'error') {
        // SSE backend says the job row no longer exists. Stop the spinner
        // and surface the message instead of spinning forever.
        setStatus('failed');
        setError(data.detail || 'Job not found');
        es.close();
      }
    };

    es.onerror = () => {
      // Don't bail — let polling take over. EventSource will keep retrying on its own.
      // We only force-close on terminal status.
    };

    // Safety-net polling — the ONLY way this card sees live updates for
    // jobs running on the remote EC2 worker (EC2 emits to its own in-process
    // EventEmitter, which never reaches the API's SSE handler). Also the
    // ONLY update channel in production: the API Gateway in front of Cloud
    // Run returns 502 on long-lived SSE streams (verified 2026-05-19), so
    // the EventSource above never actually receives any events live —
    // it just retries silently. Polls while the job is in any non-terminal
    // state, including 'pending' (queued).
    const poll = setInterval(async () => {
      const cur = statusRef.current;
      if (cur === 'completed' || cur === 'failed') return;
      try {
        // GET /api/scrape returns { data: { rows: [...], total: N } } —
        // NOT a bare array. The previous code did `.find()` on the wrapper
        // object, which throws TypeError, and the silent catch swallowed
        // it on every single tick — i.e. the poll never updated ANYTHING
        // for non-Trustpilot scrapes for any user, ever. Bug discovered
        // 2026-05-19 while debugging a card stuck at 'pending' even though
        // the EC2 worker had been running the job for 40+ seconds.
        const res = await api.get('/scrape');
        const jobs = (res.data?.data?.rows ?? []) as ScrapeJob[];
        const j = jobs.find((row) => row.id === jobId);
        if (!j) return;
        // Surface platform/country/category from the row in case the SSE
        // current event hasn't landed yet (or this card was opened on a
        // refresh after the worker already started).
        if (j.platform && !platform) setPlatform(j.platform);
        const f = (j.filters || null) as { country?: string; category?: string } | null;
        const realCountry =
          j.country && !j.country.startsWith('_') ? j.country : f?.country;
        const realCategory =
          j.category && j.category !== 'all' ? j.category : f?.category;
        if (realCountry && !country) setCountry(realCountry);
        if (realCategory && !category) setCategory(realCategory);
        if (j.started_at && !startedAt) setStartedAt(j.started_at);
        setLiveJob({ total_found: j.total_found ?? 0, total_scraped: j.total_scraped ?? 0 });
        // Pull persisted progress events into the local feed (migration 042).
        // Cloud Run + API Gateway swallows long-lived SSE, so this poll is
        // the ONLY path that fills the Live Activity panel in production.
        const recent = (j as { recent_events?: Array<{ stage: string; detail: string; ts: string }> }).recent_events;
        if (recent && Array.isArray(recent) && recent.length > 0) {
          setProgress((prev) => mergeProgress(prev, recent, jobId));
        }
        // Mirror the DB status into local state — without this, a card
        // initialised at 'pending' would never advance to 'running' for
        // an EC2-claimed job.
        if (j.status && j.status !== cur) {
          setStatus(j.status);
        }
        if (j.status === 'completed' || j.status === 'failed') {
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

  // Auto-dismiss countdown — anchored to the job's persistent completed_at
  // timestamp, not to component mount. If we anchored on mount, then every
  // page navigation or refresh would unmount this card, the cleanup would
  // clear the timer, and a fresh 60s would start on re-mount — so a card
  // would never actually dismiss when the user is moving around the app.
  // By computing remaining = (completed_at + 60s) - now() on every effect
  // run, navigating away just pauses the visible countdown; coming back
  // shows the real remaining time, and re-entering after the deadline
  // dismisses immediately.
  const [dismissIn, setDismissIn] = useState<number | null>(null);

  useEffect(() => {
    if (!isTerminal) {
      setDismissIn(null);
      return;
    }
    // If the server hasn't told us completed_at yet (SSE delivers status
    // a beat before the DB row carries the timestamp), fall back to "60s
    // from now" so we don't sit forever showing no countdown. The effect
    // re-runs when completedAt arrives and rebases on the real anchor.
    const completedMs = completedAt ? new Date(completedAt).getTime() : Date.now();
    const dismissAtMs = completedMs + AUTO_DISMISS_MS;
    const remainingMs = dismissAtMs - Date.now();

    if (remainingMs <= 0) {
      // Already past the deadline (e.g. user returned to the page well
      // after the job finished). Schedule the dismiss for next tick so
      // we don't run a parent setState during this component's render.
      const t = setTimeout(onDismiss, 0);
      return () => clearTimeout(t);
    }

    setDismissIn(Math.ceil(remainingMs / 1000));
    const tick = setInterval(() => {
      const left = dismissAtMs - Date.now();
      setDismissIn(left <= 0 ? 0 : Math.ceil(left / 1000));
    }, 1000);
    const dismissTimer = setTimeout(onDismiss, remainingMs);
    return () => {
      clearInterval(tick);
      clearTimeout(dismissTimer);
    };
  }, [isTerminal, completedAt, onDismiss]);

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
          <div className="flex items-center gap-2 flex-shrink-0">
            {dismissIn != null && dismissIn > 0 && (
              <span
                className="text-[10px] font-bold uppercase tracking-wider text-secondary"
                title="This card will dismiss itself; click ✕ to remove now"
              >
                Auto-dismiss in {dismissIn}s
              </span>
            )}
            <button
              onClick={onDismiss}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-secondary hover:bg-surface-container hover:text-on-surface transition-colors"
              aria-label="Dismiss this scrape"
              title="Dismiss"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        )}
      </div>
      <JobProgress
        kind="scrape"
        status={status as 'running' | 'completed' | 'failed' | null}
        progress={progress}
        error={error}
        failedCount={failedCount}
        liveJob={liveJob}
        platform={platform}
        startedAt={startedAt}
        completedAt={completedAt}
        onCancel={status === 'running' ? onCancel : undefined}
      />
    </div>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2, XCircle, AlertTriangle, RotateCcw, Square } from 'lucide-react';
import type { ScrapeProgress as ScrapeProgressType } from '../types/scrape';
import { translate, summarize, type FeedLine } from './jobProgress/messages';

export type JobKind = 'scrape' | 'enrichment';

interface Props {
  kind: JobKind;
  status: 'running' | 'completed' | 'failed' | null;
  progress: ScrapeProgressType[];
  error?: string | null;
  /** Fallback counters from the DB (jobs poll). Used when SSE doesn't fire. */
  liveJob?: { total_found: number; total_scraped: number } | null;
  failedCount?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  onCancel?: () => void;
  onRetryFailed?: () => void;
}

interface PhaseDef {
  key: string;
  label: string;
}

const SCRAPE_PHASES: PhaseDef[] = [
  { key: 'category', label: 'Find companies' },
  { key: 'dedup', label: 'Remove duplicates' },
  { key: 'profile', label: 'Scrape profiles' },
  { key: 'checkpoint', label: 'Save profiles' },
  { key: 'enrich', label: 'Enrich websites' },
  { key: 'final', label: 'Finalize' },
];

const ENRICH_PHASES: PhaseDef[] = [
  { key: 'enrich', label: 'Check websites' },
  { key: 'final', label: 'Finalize' },
];

function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function JobProgress({
  kind,
  status,
  progress,
  error,
  liveJob,
  failedCount = 0,
  startedAt,
  completedAt,
  onCancel,
  onRetryFailed,
}: Props) {
  const [cancelling, setCancelling] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const feedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (status !== 'running') return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [status]);

  // Auto-scroll to the latest line unless the user has scrolled up
  useEffect(() => {
    if (!autoScroll || !feedRef.current) return;
    feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [progress, autoScroll]);

  const phases = kind === 'scrape' ? SCRAPE_PHASES : ENRICH_PHASES;
  const summary = useMemo(() => summarize(progress), [progress]);
  const feed: FeedLine[] = useMemo(() => {
    const lines: FeedLine[] = [];
    for (const p of progress) {
      const line = translate(p);
      if (line) lines.push(line);
    }
    return lines;
  }, [progress]);

  // Elapsed time (and ETA for scrape profile phase)
  const startedMs = startedAt ? new Date(startedAt).getTime() : null;
  const endedMs = completedAt ? new Date(completedAt).getTime() : null;
  const elapsedMs = startedMs ? (endedMs ?? now) - startedMs : null;

  // Progress bar driver — prefer SSE fraction, fall back to DB counters
  const fraction = (() => {
    if (kind === 'enrichment') {
      if (summary.sitesTotal > 0) {
        return { current: summary.sitesChecked, total: summary.sitesTotal, label: 'Websites checked' };
      }
    } else {
      if (summary.profilesTotal > 0) {
        return { current: summary.profilesProcessed, total: summary.profilesTotal, label: 'Profiles scraped' };
      }
      if (liveJob && liveJob.total_found > 0 && liveJob.total_scraped > 0) {
        return { current: liveJob.total_scraped, total: liveJob.total_found, label: 'Profiles saved' };
      }
    }
    return null;
  })();

  let etaMs: number | null = null;
  if (status === 'running' && elapsedMs && fraction && fraction.current > 0) {
    const remaining = fraction.total - fraction.current;
    etaMs = Math.max(0, (elapsedMs / fraction.current) * remaining);
  }

  const handleCancel = async () => {
    if (!onCancel || cancelling) return;
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  };

  const onFeedScroll = () => {
    if (!feedRef.current) return;
    const el = feedRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  };

  const headline = (() => {
    if (status === 'running') return kind === 'enrichment' ? 'Finding website emails…' : 'Scraping in progress…';
    if (status === 'completed') return kind === 'enrichment' ? 'Enrichment finished' : 'Scrape finished';
    if (status === 'failed') return 'Stopped';
    return '';
  })();

  return (
    <div className="bg-white rounded-xl border border-slate-100 p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          {status === 'running' && <Loader2 size={18} className="animate-spin text-[#b0004a]" />}
          {status === 'completed' && <CheckCircle2 size={18} className="text-[#006630]" />}
          {status === 'failed' && <XCircle size={18} className="text-red-500" />}
          <div>
            <h3 className="font-bold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {headline}
            </h3>
            {startedMs && (
              <p className="text-xs text-secondary mt-0.5">
                Elapsed <span className="font-mono font-semibold text-on-surface">{formatDuration(elapsedMs ?? 0)}</span>
                {etaMs !== null && status === 'running' && (
                  <> · about <span className="font-mono font-semibold text-on-surface">{formatDuration(etaMs)}</span> to go</>
                )}
              </p>
            )}
          </div>
          {(() => {
            const totalFailed = failedCount || summary.failures;
            if (totalFailed <= 0) return null;
            return (
              <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-red-700 bg-red-50 border border-red-100 px-2 py-0.5 rounded-full">
                <AlertTriangle size={11} /> {totalFailed} need{totalFailed === 1 ? 's' : ''} attention
              </span>
            );
          })()}
        </div>

        <div className="flex items-center gap-2">
          {status === 'running' && onCancel && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              {cancelling ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {status === 'completed' && failedCount > 0 && onRetryFailed && (
            <button
              onClick={onRetryFailed}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#b0004a] border border-[#b0004a]/30 rounded-lg px-3 py-1.5 hover:bg-[#ffd9de]/40 transition-colors"
            >
              <RotateCcw size={12} /> Retry the ones that failed
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Phase stepper */}
      <div className="flex items-center flex-wrap gap-2">
        {phases.map((phase, i) => {
          const isDone = isPhaseDone(phase.key, summary.currentPhase, progress);
          const isActive = summary.currentPhase === phase.key && status === 'running';
          return (
            <div key={phase.key} className="flex items-center">
              {i > 0 && <div className={`w-5 h-px mx-1 ${isDone ? 'bg-[#006630]' : 'bg-slate-200'}`} />}
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] whitespace-nowrap border ${
                  isDone
                    ? 'bg-[#e8f7ec] text-[#006630] border-[#006630]/30'
                    : isActive
                      ? 'bg-[#ffd9de] text-[#b0004a] border-[#b0004a]/30 font-bold'
                      : 'bg-slate-50 text-slate-400 border-transparent'
                }`}
              >
                {isDone && <CheckCircle2 size={11} />}
                {isActive && <Loader2 size={11} className="animate-spin" />}
                {phase.label}
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary cards */}
      <div className={`grid gap-3 ${kind === 'scrape' ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-1 md:grid-cols-3'}`}>
        {kind === 'scrape' ? (
          <>
            <Card
              label="Companies found"
              value={summary.companiesFound || (liveJob?.total_found ?? 0)}
              accent="#b0004a"
            />
            <Card
              label="Profiles processed"
              value={
                summary.profilesTotal > 0
                  ? `${summary.profilesProcessed} / ${summary.profilesTotal}`
                  : (liveJob?.total_scraped ?? 0)
              }
              accent="#004b7f"
            />
            <Card
              label="From Trustpilot"
              value={summary.emailsCaptured}
              accent="#006630"
              hint="emails listed on the profile page"
            />
            <Card
              label="From websites"
              value={summary.emailsFound}
              accent="#006630"
              hint="emails found by visiting company sites"
            />
          </>
        ) : (
          <>
            <Card
              label="Websites checked"
              value={
                summary.sitesTotal > 0
                  ? `${summary.sitesChecked} / ${summary.sitesTotal}`
                  : summary.sitesChecked
              }
              accent="#004b7f"
            />
            <Card label="Emails found" value={summary.emailsFound} accent="#006630" />
            <Card label="Blocked or skipped" value={summary.failures} accent="#b35500" />
          </>
        )}
      </div>

      {/* Progress bar */}
      {fraction && status === 'running' && (
        <div>
          <div className="flex justify-between items-baseline text-xs mb-1.5">
            <span className="text-secondary">{fraction.label}</span>
            <span className="font-mono font-semibold text-on-surface">
              {fraction.current} / {fraction.total}
            </span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
            <div
              className="bg-[#b0004a] h-2 rounded-full transition-all duration-500"
              style={{
                width: `${Math.min((fraction.current / Math.max(fraction.total, 1)) * 100, 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Activity feed */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[11px] font-bold uppercase tracking-widest text-slate-400">
            Live activity
          </h4>
          {!autoScroll && (
            <button
              onClick={() => {
                if (feedRef.current) {
                  feedRef.current.scrollTop = feedRef.current.scrollHeight;
                }
                setAutoScroll(true);
              }}
              className="text-[11px] font-bold text-[#b0004a] hover:text-[#8a003a]"
            >
              Jump to latest ↓
            </button>
          )}
        </div>
        <div
          ref={feedRef}
          onScroll={onFeedScroll}
          className="max-h-72 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/60 divide-y divide-slate-100/70"
        >
          {feed.length === 0 && status === 'running' && (
            <div className="px-4 py-6 text-center text-sm text-secondary">
              Getting things ready…
            </div>
          )}
          {feed.length === 0 && status !== 'running' && (
            <div className="px-4 py-6 text-center text-sm text-secondary">
              No activity yet.
            </div>
          )}
          {feed.map((line, i) => (
            <FeedRow key={i} line={line} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: number | string;
  accent: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
      <p
        className="text-xl font-black mt-1"
        style={{ fontFamily: 'Manrope, sans-serif', color: accent }}
      >
        {value}
      </p>
      {hint && <p className="text-[10px] text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function FeedRow({ line }: { line: FeedLine }) {
  const palette = {
    info: { dot: 'bg-slate-300', text: 'text-slate-700' },
    progress: { dot: 'bg-slate-400', text: 'text-slate-700' },
    success: { dot: 'bg-[#006630]', text: 'text-[#006630]' },
    warn: { dot: 'bg-amber-500', text: 'text-amber-800' },
    error: { dot: 'bg-red-500', text: 'text-red-700' },
    phase: { dot: 'bg-[#b0004a]', text: 'text-[#b0004a] font-semibold' },
  }[line.kind];

  return (
    <div className="flex items-start gap-3 px-4 py-2 text-sm">
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full ${palette.dot} shrink-0`} />
      {line.timestamp && (
        <span className="font-mono text-[10px] text-slate-400 shrink-0 mt-1">
          {new Date(line.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </span>
      )}
      <span className={palette.text}>{line.text}</span>
    </div>
  );
}

/**
 * Decide whether a phase is done by walking the event list. A phase is done
 * once we've seen its *_done event OR once the summary's current phase has
 * moved past it.
 */
function isPhaseDone(
  key: string,
  currentPhase: string,
  events: ScrapeProgressType[],
): boolean {
  const doneMarker = `${key}_done`;
  for (const e of events) {
    if (e.stage === doneMarker) return true;
    if (e.stage === 'completed' && (key === 'final' || currentPhase !== 'failed')) return true;
  }
  // Phase order — if current phase is later, the given phase is done
  const ORDER = ['category', 'dedup', 'profile', 'checkpoint', 'enrich', 'final', 'done'];
  const keyIdx = ORDER.indexOf(key);
  const curIdx = ORDER.indexOf(currentPhase);
  if (keyIdx >= 0 && curIdx >= 0 && curIdx > keyIdx) return true;
  return false;
}

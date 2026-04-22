import { useEffect, useState } from 'react';
import { Clock, Loader2, CheckCircle2, XCircle, AlertTriangle, RotateCcw, Square } from 'lucide-react';
import type { ScrapeProgress as ScrapeProgressType } from '../types/scrape';

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

// The ordered phases of a scrape job
const PHASES = [
  { key: 'category', label: 'Category Scrape' },
  { key: 'dedup', label: 'Deduplication' },
  { key: 'profile', label: 'Profile Scrape' },
  { key: 'checkpoint', label: 'Save Profiles' },
  { key: 'enrich', label: 'Website Enrich' },
  { key: 'final', label: 'Final Save' },
] as const;

function getActivePhase(progress: ScrapeProgressType[]): string | null {
  // Walk progress backwards to find latest phase-indicating stage
  for (let i = progress.length - 1; i >= 0; i--) {
    const stage = progress[i].stage;
    if (stage.startsWith('category')) return 'category';
    if (stage.startsWith('dedup')) return 'dedup';
    if (stage.startsWith('profile') || stage === 'profile_progress') return 'profile';
    if (stage.startsWith('checkpoint')) return 'checkpoint';
    if (stage.startsWith('enrich') || stage === 'enrich_progress') return 'enrich';
    if (stage.startsWith('final') || stage.startsWith('upsert')) return 'final';
  }
  return null;
}

function getCompletedPhases(progress: ScrapeProgressType[]): Set<string> {
  const completed = new Set<string>();
  for (const p of progress) {
    if (p.stage === 'category_done') completed.add('category');
    if (p.stage === 'dedup_done') completed.add('dedup');
    if (p.stage === 'profile_done') completed.add('profile');
    if (p.stage === 'checkpoint_done') completed.add('checkpoint');
    if (p.stage === 'enrich_done') completed.add('enrich');
    if (p.stage === 'upsert_done' || p.stage === 'completed') {
      completed.add('final');
    }
  }
  return completed;
}

function parseProgressFraction(progress: ScrapeProgressType[]): { current: number; total: number } | null {
  // Find the latest N/M style detail from profile_progress or enrich_progress
  for (let i = progress.length - 1; i >= 0; i--) {
    const { stage, detail } = progress[i];
    if ((stage === 'profile_progress' || stage === 'enrich_progress') && detail.includes('/')) {
      const [cur, tot] = detail.split('/').map(Number);
      if (!isNaN(cur) && !isNaN(tot) && tot > 0) return { current: cur, total: tot };
    }
  }
  return null;
}

interface CompletionMetrics {
  totalFound?: number;
  skipped?: number;
  processed?: number;
  saved?: number;
  enriched?: number;
  failed?: number;
}

function parseSummary(progress: ScrapeProgressType[]): {
  profilesFound?: number;
  emailsEnriched?: number;
  enrichSkipped?: string;
  enrichRan: boolean;
  completion?: CompletionMetrics;
} {
  let profilesFound: number | undefined;
  let emailsEnriched: number | undefined;
  let enrichSkipped: string | undefined;
  let enrichRan = false;
  let completion: CompletionMetrics | undefined;

  for (const p of progress) {
    if (p.stage === 'profile_done' && p.detail) {
      profilesFound = parseInt(p.detail, 10);
    }
    if (p.stage === 'enrich_start') {
      enrichRan = true;
    }
    if (p.stage === 'enrich_done' && p.detail) {
      emailsEnriched = parseInt(p.detail, 10);
    }
    // "Nothing to enrich" case — detail from Python print
    if (p.stage === 'enrich_progress' && p.detail?.includes('0/')) {
      enrichSkipped = 'No leads had a website URL to enrich';
    }
    // Parse honest completion metrics JSON
    if (p.stage === 'completed' && p.detail) {
      try {
        completion = JSON.parse(p.detail) as CompletionMetrics;
      } catch { /* detail is a plain string, not JSON — ignore */ }
    }
  }
  return { profilesFound, emailsEnriched, enrichSkipped, enrichRan, completion };
}

function humanLabel(stage: string, detail: string): string {
  switch (stage) {
    case 'started': return 'Scrape job started';
    case 'category_done': return `Found ${detail} companies on Trustpilot`;
    case 'dedup_start': return `Checking ${detail} URLs against existing leads…`;
    case 'dedup_done': { const [skip, total] = detail.split('/'); return `Dedup: ${skip} already in DB — scraping ${parseInt(total) - parseInt(skip)} new`; }
    case 'profile_done': return `Scraped ${detail} profiles`;
    case 'checkpoint_save': return 'Saving profile data to database…';
    case 'checkpoint_done': return 'Profile data saved ✓';
    case 'enrich_start': return 'Starting website email enrichment…';
    case 'enrich_done': return `Enrichment complete — ${detail} new website emails found`;
    case 'partial_save': return detail || 'Partial batch saved to Lead Matrix';
    case 'final_save': return 'Saving enriched data…';
    case 'upsert_done': return `Saved ${detail.split('/')[0]} leads to database ✓`;
    case 'completed': {
      try {
        const m = JSON.parse(detail) as CompletionMetrics;
        const parts = [`Saved ${m.saved ?? 0} new leads`];
        if ((m.skipped ?? 0) > 0) parts.push(`skipped ${m.skipped} duplicates`);
        if ((m.enriched ?? 0) > 0) parts.push(`found ${m.enriched} emails`);
        if ((m.failed ?? 0) > 0) parts.push(`${m.failed} failed`);
        return parts.join(', ') + ' ✓';
      } catch { return detail || 'All done ✓'; }
    }
    case 'failed': return `Failed: ${detail}`;
    case 'item_failed': return `⚠ Failed: ${detail}`;
    default: return detail || stage;
  }
}

interface Props {
  status: 'running' | 'completed' | 'failed' | null;
  progress: ScrapeProgressType[];
  error: string | null;
  failedCount?: number;
  jobId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  /** Authoritative DB-derived counters from the jobs poll — fallback when SSE events
   *  don't arrive (e.g. Google API Gateway dropping server-sent events). */
  liveJob?: { total_found: number; total_scraped: number } | null;
  onCancel?: () => void;
  onRetryFailed?: () => void;
}

export default function ScrapeProgress({
  status, progress, error, failedCount = 0,
  startedAt, completedAt, liveJob,
  onCancel, onRetryFailed,
}: Props) {
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Tick every second while running so elapsed + ETA stay live
  useEffect(() => {
    if (status !== 'running') return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [status]);

  if (!status) return null;

  const handleCancel = async () => {
    if (!onCancel || cancelling) return;
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  };

  const activePhase = getActivePhase(progress);
  const completedPhases = getCompletedPhases(progress);
  const summary = parseSummary(progress);

  // Prefer fine-grained SSE fraction; fall back to the jobs-poll counters so the
  // progress bar still ticks up even when server-sent events aren't flowing.
  const sseFraction = parseProgressFraction(progress);
  const pollFraction = (!sseFraction && liveJob && liveJob.total_found > 0 && liveJob.total_scraped > 0)
    ? { current: liveJob.total_scraped, total: liveJob.total_found }
    : null;
  const fraction = sseFraction ?? pollFraction;

  // Elapsed + ETA. ETA is only meaningful once the profile phase has real
  // per-item progress; before that we can't extrapolate honestly.
  const startedMs = startedAt ? new Date(startedAt).getTime() : null;
  const endedMs = completedAt ? new Date(completedAt).getTime() : null;
  const elapsedMs = startedMs ? (endedMs ?? now) - startedMs : null;
  let etaMs: number | null = null;
  if (status === 'running' && elapsedMs !== null && fraction && fraction.current > 0 && activePhase === 'profile') {
    const remaining = fraction.total - fraction.current;
    etaMs = (elapsedMs / fraction.current) * remaining;
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mt-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {status === 'running' && <Loader2 size={18} className="animate-spin text-blue-500" />}
          {status === 'completed' && <CheckCircle2 size={18} className="text-green-500" />}
          {status === 'failed' && <XCircle size={18} className="text-red-500" />}
          <h3 className="font-medium">
            {status === 'running' && 'Scraping in progress...'}
            {status === 'completed' && 'Scrape completed'}
            {status === 'failed' && 'Scrape failed'}
          </h3>
          {failedCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-red-600 bg-red-50 px-2 py-0.5 rounded-full">
              <AlertTriangle size={12} />
              {failedCount} failed
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status === 'running' && onCancel && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="inline-flex items-center gap-1.5 text-xs text-red-600 hover:text-red-700 border border-red-200 rounded-md px-2.5 py-1.5 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cancelling ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
              {cancelling ? 'Cancelling...' : 'Cancel'}
            </button>
          )}
          {status === 'completed' && failedCount > 0 && onRetryFailed && (
            <button
              onClick={onRetryFailed}
              className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 border border-blue-200 rounded-md px-2.5 py-1.5 hover:bg-blue-50 transition-colors"
            >
              <RotateCcw size={12} /> Retry Failed
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

      {/* Elapsed + ETA */}
      {startedMs && (
        <div className="flex items-center gap-4 mb-4 text-xs text-gray-600">
          <span className="inline-flex items-center gap-1.5">
            <Clock size={12} className="text-gray-400" />
            Elapsed <span className="font-mono font-medium text-gray-800">{formatDuration(elapsedMs ?? 0)}</span>
          </span>
          {etaMs !== null && (
            <span className="inline-flex items-center gap-1.5">
              ETA <span className="font-mono font-medium text-gray-800">~{formatDuration(etaMs)}</span>
              <span className="text-gray-400">remaining</span>
            </span>
          )}
          {status === 'running' && etaMs === null && (
            <span className="text-gray-400">ETA calculating…</span>
          )}
        </div>
      )}

      {/* Phase Step Indicator */}
      <div className="flex items-center gap-1 mb-4 overflow-x-auto">
        {PHASES.map((phase, i) => {
          const isCompleted = completedPhases.has(phase.key);
          const isActive = activePhase === phase.key && status === 'running';
          return (
            <div key={phase.key} className="flex items-center">
              {i > 0 && <div className={`w-4 h-px mx-1 ${isCompleted ? 'bg-green-400' : 'bg-gray-200'}`} />}
              <div className={`flex items-center gap-1 px-2 py-1 rounded text-xs whitespace-nowrap ${
                isCompleted ? 'bg-green-50 text-green-700' :
                isActive ? 'bg-blue-50 text-blue-700 font-medium' :
                'bg-gray-50 text-gray-400'
              }`}>
                {isCompleted && <CheckCircle2 size={12} className="text-green-500" />}
                {isActive && <Loader2 size={12} className="animate-spin text-blue-500" />}
                {phase.label}
              </div>
            </div>
          );
        })}
      </div>

      {/* Per-item Progress Bar */}
      {fraction && status === 'running' && (
        <div className="mb-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{activePhase === 'profile' ? 'Scraping profiles' : 'Enriching websites'}</span>
            <span>{fraction.current} / {fraction.total}</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${Math.min((fraction.current / fraction.total) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Summary cards (shown when done or if we have data) */}
      {(status === 'completed' || summary.profilesFound !== undefined || summary.emailsEnriched !== undefined) && (
        <div className="flex gap-3 mb-4 flex-wrap">
          {/* Honest completion metrics — shown when available */}
          {summary.completion && (
            <>
              <div className="flex items-center gap-2 bg-green-50 border border-green-100 rounded-lg px-3 py-2 text-xs">
                <span className="material-symbols-outlined text-[16px] text-green-600">save</span>
                <span className="text-green-800 font-semibold">{summary.completion.saved} saved to DB</span>
              </div>
              {(summary.completion.skipped ?? 0) > 0 && (
                <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs">
                  <span className="material-symbols-outlined text-[16px] text-gray-500">filter_alt</span>
                  <span className="text-gray-700 font-semibold">{summary.completion.skipped} duplicates skipped</span>
                </div>
              )}
              {(summary.completion.enriched ?? 0) > 0 && (
                <div className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs">
                  <span className="material-symbols-outlined text-[16px] text-blue-600">language</span>
                  <span className="text-blue-800 font-semibold">{summary.completion.enriched} emails found</span>
                </div>
              )}
              {(summary.completion.failed ?? 0) > 0 && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-100 rounded-lg px-3 py-2 text-xs">
                  <span className="material-symbols-outlined text-[16px] text-red-600">error</span>
                  <span className="text-red-800 font-semibold">{summary.completion.failed} failed</span>
                </div>
              )}
            </>
          )}
          {/* Fallback to old-style metrics when completion JSON isn't available */}
          {!summary.completion && summary.profilesFound !== undefined && (
            <div className="flex items-center gap-2 bg-green-50 border border-green-100 rounded-lg px-3 py-2 text-xs">
              <span className="material-symbols-outlined text-[16px] text-green-600">business</span>
              <span className="text-green-800 font-semibold">{summary.profilesFound} profiles scraped</span>
            </div>
          )}
          {!summary.completion && summary.enrichRan && summary.emailsEnriched !== undefined && (
            <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs border ${
              summary.emailsEnriched > 0
                ? 'bg-blue-50 border-blue-100'
                : 'bg-amber-50 border-amber-100'
            }`}>
              <span className={`material-symbols-outlined text-[16px] ${summary.emailsEnriched > 0 ? 'text-blue-600' : 'text-amber-600'}`}>
                language
              </span>
              {summary.emailsEnriched > 0 ? (
                <span className="text-blue-800 font-semibold">{summary.emailsEnriched} website emails found</span>
              ) : (
                <span className="text-amber-800 font-semibold">
                  No website emails found
                  <span className="font-normal block text-[10px] text-amber-600">
                    Possible: no website URLs on these profiles, or sites had no contact email
                  </span>
                </span>
              )}
            </div>
          )}
          {summary.enrichRan && !summary.enrichSkipped && summary.emailsEnriched === undefined && status === 'running' && (
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs">
              <Loader2 size={14} className="animate-spin text-blue-500" />
              <span className="text-blue-800">Enriching website emails…</span>
            </div>
          )}
        </div>
      )}

      {/* Activity Log */}
      <div className="max-h-48 overflow-y-auto bg-gray-50 rounded p-3 text-xs space-y-1">
        {progress.map((p, i) => {
          // Skip verbose per-item progress in the log
          if (p.stage === 'profile_progress' || p.stage === 'enrich_progress' || p.stage === 'upsert_progress') return null;
          const label = humanLabel(p.stage, p.detail);
          return (
            <div key={i} className={`flex items-start gap-1.5 ${
              p.stage === 'item_failed' ? 'text-red-500' :
              p.stage === 'completed' ? 'text-green-600 font-medium' :
              p.stage === 'failed' ? 'text-red-600 font-medium' :
              p.stage.includes('done') ? 'text-gray-700 font-medium' :
              'text-gray-500'
            }`}>
              {p.timestamp && (
                <span className="text-gray-300 shrink-0 font-mono">
                  {new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              )}
              <span>{label}</span>
            </div>
          );
        })}
        {progress.length === 0 && status === 'running' && (
          <div className="text-gray-400">Waiting for progress updates...</div>
        )}
      </div>
    </div>
  );
}

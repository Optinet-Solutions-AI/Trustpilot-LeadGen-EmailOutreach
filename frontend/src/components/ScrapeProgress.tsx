import { Loader2, CheckCircle2, XCircle, AlertTriangle, RotateCcw, Square } from 'lucide-react';
import type { ScrapeProgress as ScrapeProgressType } from '../types/scrape';

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

interface Props {
  status: 'running' | 'completed' | 'failed' | null;
  progress: ScrapeProgressType[];
  error: string | null;
  failedCount?: number;
  jobId?: string | null;
  onCancel?: () => void;
  onRetryFailed?: () => void;
}

export default function ScrapeProgress({
  status, progress, error, failedCount = 0,
  onCancel, onRetryFailed,
}: Props) {
  if (!status) return null;

  const activePhase = getActivePhase(progress);
  const completedPhases = getCompletedPhases(progress);
  const fraction = parseProgressFraction(progress);

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
              onClick={onCancel}
              className="inline-flex items-center gap-1.5 text-xs text-red-600 hover:text-red-700 border border-red-200 rounded-md px-2.5 py-1.5 hover:bg-red-50 transition-colors"
            >
              <Square size={12} /> Cancel
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

      {/* Activity Log */}
      <div className="max-h-48 overflow-y-auto bg-gray-50 rounded p-3 text-xs font-mono space-y-1">
        {progress.map((p, i) => {
          // Skip verbose per-item progress in the log
          if (p.stage === 'profile_progress' || p.stage === 'enrich_progress' || p.stage === 'upsert_progress') return null;
          return (
            <div key={i} className={`${
              p.stage === 'item_failed' ? 'text-red-500' :
              p.stage === 'completed' ? 'text-green-600' :
              p.stage === 'failed' ? 'text-red-600' :
              'text-gray-600'
            }`}>
              <span className="text-gray-400">[{p.stage}]</span> {p.detail}
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

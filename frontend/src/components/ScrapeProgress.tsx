import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import type { ScrapeProgress as ScrapeProgressType } from '../types/scrape';

interface Props {
  status: 'running' | 'completed' | 'failed' | null;
  progress: ScrapeProgressType[];
  error: string | null;
}

export default function ScrapeProgress({ status, progress, error }: Props) {
  if (!status) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mt-4">
      <div className="flex items-center gap-2 mb-3">
        {status === 'running' && <Loader2 size={18} className="animate-spin text-blue-500" />}
        {status === 'completed' && <CheckCircle2 size={18} className="text-green-500" />}
        {status === 'failed' && <XCircle size={18} className="text-red-500" />}
        <h3 className="font-medium">
          {status === 'running' && 'Scraping in progress...'}
          {status === 'completed' && 'Scrape completed'}
          {status === 'failed' && 'Scrape failed'}
        </h3>
      </div>

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      <div className="max-h-48 overflow-y-auto bg-gray-50 rounded p-3 text-xs font-mono space-y-1">
        {progress.map((p, i) => (
          <div key={i} className="text-gray-600">
            <span className="text-gray-400">[{p.stage}]</span> {p.detail}
          </div>
        ))}
        {progress.length === 0 && status === 'running' && (
          <div className="text-gray-400">Waiting for progress updates...</div>
        )}
      </div>
    </div>
  );
}

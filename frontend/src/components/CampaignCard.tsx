import {
  Loader2, Trash2, Copy, Rocket, CheckCircle, StopCircle, ImageIcon, MoreHorizontal,
} from 'lucide-react';
import { useState } from 'react';
import type { Campaign } from '../types/campaign';

interface Props {
  campaign: Campaign;
  isSending: boolean;
  sendProgress: { sent: number; failed: number; total: number } | null;
  onLaunch: (campaignId: string) => void;   // opens mandatory Test Flight flow
  onDuplicate: (campaignId: string) => Promise<void>;
  onDelete: (campaignId: string, name: string) => Promise<void>;
  onViewDetail: (campaign: Campaign) => void;
  deletingId: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  draft:     'bg-gray-100 text-gray-600',
  sending:   'bg-blue-100 text-blue-700',
  sent:      'bg-green-100 text-green-700',
  completed: 'bg-purple-100 text-purple-700',
};

export default function CampaignCard({
  campaign: c, isSending, sendProgress, onLaunch,
  onDuplicate, onDelete, onViewDetail, deletingId,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  const hasLeads    = (c.lead_count ?? 0) > 0;
  const canLaunch   = c.status === 'draft' && hasLeads && !isSending;
  const isThisSending = c.status === 'sending';

  const replyRate = c.total_sent > 0
    ? ((c.total_replied / c.total_sent) * 100).toFixed(1)
    : '0';

  const handleDuplicate = async () => {
    setDuplicating(true);
    setMenuOpen(false);
    try { await onDuplicate(c.id); } finally { setDuplicating(false); }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-sm transition-shadow">

      {/* Top row: status badge + date */}
      <div className="flex items-center justify-between mb-2">
        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[c.status] ?? STATUS_STYLES.draft}`}>
          {isThisSending && <Loader2 size={10} className="animate-spin" />}
          {c.status}
        </span>
        <span className="text-xs text-gray-400">{new Date(c.created_at).toLocaleDateString()}</span>
      </div>

      {/* Campaign name — clickable to open detail */}
      <button onClick={() => onViewDetail(c)} className="text-left w-full group">
        <h3 className="text-sm font-semibold text-gray-900 group-hover:text-blue-600 transition-colors flex items-center gap-1.5">
          {c.name}
          {c.include_screenshot && <ImageIcon size={12} className="text-blue-400" />}
        </h3>
      </button>

      {/* Subject preview */}
      {c.template_subject && (
        <p className="text-xs text-gray-400 mt-1 truncate">
          {c.template_subject}
        </p>
      )}

      {/* Metrics row */}
      <div className="flex items-center gap-4 mt-3 text-xs">
        <span className={`${hasLeads ? 'text-gray-600' : 'text-red-400'}`}>
          <span className="font-semibold">{c.lead_count ?? 0}</span> leads
          {!hasLeads && c.status === 'draft' && <span className="ml-1 italic">⚠ none assigned</span>}
        </span>
        {c.total_sent > 0 && (
          <>
            <span className="text-blue-600">
              <span className="font-semibold">{c.total_sent}</span> sent
            </span>
            <span className="text-green-600">
              <span className="font-semibold">{c.total_replied}</span> replied
              <span className="text-gray-400 ml-0.5">({replyRate}%)</span>
            </span>
            {c.total_bounced > 0 && (
              <span className="text-red-500">
                <span className="font-semibold">{c.total_bounced}</span> bounced
              </span>
            )}
          </>
        )}
      </div>

      {/* Live send progress bar */}
      {isThisSending && sendProgress && sendProgress.total > 0 && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-blue-600 mb-1">
            <span>{sendProgress.sent + sendProgress.failed} / {sendProgress.total}</span>
            <span>{sendProgress.sent} sent{sendProgress.failed > 0 ? `, ${sendProgress.failed} failed` : ''}</span>
          </div>
          <div className="w-full bg-blue-100 rounded-full h-1.5">
            <div
              className="bg-blue-600 h-1.5 rounded-full transition-all"
              style={{ width: `${Math.round(((sendProgress.sent + sendProgress.failed) / sendProgress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-gray-100">

        {/* Primary launch button — only on sendable draft campaigns */}
        {canLaunch && (
          <button
            onClick={() => onLaunch(c.id)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
          >
            <Rocket size={13} />
            Launch Campaign
          </button>
        )}

        {/* Sending state */}
        {isThisSending && (
          <span className="text-xs text-blue-500 flex items-center gap-1">
            <Loader2 size={11} className="animate-spin" /> Sending…
          </span>
        )}

        {/* Completed state */}
        {(c.status === 'sent' || c.status === 'completed') && (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle size={11} /> Completed
          </span>
        )}

        {/* Overflow menu */}
        <div className="ml-auto relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <MoreHorizontal size={16} />
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-40">
                <button
                  onClick={() => { onViewDetail(c); setMenuOpen(false); }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                >
                  <StopCircle size={13} /> View Details
                </button>
                <button
                  onClick={handleDuplicate}
                  disabled={duplicating}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 disabled:opacity-50"
                >
                  <Copy size={13} /> {duplicating ? 'Duplicating…' : 'Duplicate'}
                </button>
                {!isThisSending && (
                  <button
                    onClick={() => { onDelete(c.id, c.name); setMenuOpen(false); }}
                    disabled={deletingId === c.id}
                    className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 disabled:opacity-50"
                  >
                    <Trash2 size={13} /> {deletingId === c.id ? 'Deleting…' : 'Delete'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

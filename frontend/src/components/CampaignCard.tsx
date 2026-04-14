import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { Campaign } from '../types/campaign';

interface Props {
  campaign: Campaign;
  isSending: boolean;
  sendProgress: { sent: number; failed: number; total: number } | null;
  onLaunch: (campaignId: string) => void;
  onDuplicate: (campaignId: string) => Promise<void>;
  onDelete: (campaignId: string, name: string) => Promise<void>;
  onViewDetail: (campaign: Campaign) => void;
  deletingId: string | null;
}

const STATUS_CONFIG: Record<string, { label: string; classes: string; dot: string }> = {
  draft:     { label: 'Draft',     classes: 'bg-surface-container-high text-secondary',        dot: 'bg-slate-400' },
  sending:   { label: 'Sending',   classes: 'bg-blue-50 text-blue-700',                        dot: 'bg-blue-500' },
  active:    { label: 'Active',    classes: 'bg-blue-50 text-blue-700',                        dot: 'bg-blue-500' },
  sent:      { label: 'Sent',      classes: 'bg-[#8ff9a8]/30 text-[#006630]',                  dot: 'bg-[#006630]' },
  completed: { label: 'Completed', classes: 'bg-[#8ff9a8]/30 text-[#006630]',                  dot: 'bg-[#006630]' },
  paused:    { label: 'Paused',    classes: 'bg-amber-50 text-amber-700',                       dot: 'bg-amber-500' },
  failed:    { label: 'Failed',    classes: 'bg-[#ffd9de] text-[#b0004a]',                     dot: 'bg-[#b0004a]' },
};

export default function CampaignCard({
  campaign: c, isSending, sendProgress, onLaunch,
  onDuplicate, onDelete, onViewDetail, deletingId,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  const hasLeads      = (c.lead_count ?? 0) > 0;
  const canLaunch     = c.status === 'draft' && hasLeads && !isSending;
  const isThisSending = c.status === 'sending';
  const sc            = STATUS_CONFIG[c.status] ?? STATUS_CONFIG.draft;

  const replyRate = c.total_sent > 0
    ? ((c.total_replied / c.total_sent) * 100).toFixed(1)
    : '0';

  const handleDuplicate = async () => {
    setDuplicating(true);
    setMenuOpen(false);
    try { await onDuplicate(c.id); } finally { setDuplicating(false); }
  };

  return (
    <div
      className="bg-surface-container-lowest rounded-xl ambient-shadow p-6 hover:shadow-lg transition-all border border-slate-50 cursor-pointer"
      onClick={() => onViewDetail(c)}
    >

      {/* Top row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${sc.classes}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${sc.dot} ${isThisSending ? 'animate-pulse' : ''}`} />
            {isThisSending ? <Loader2 size={10} className="animate-spin" /> : null}
            {sc.label}
          </span>
          {c.email_platform && (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-[10px] font-bold bg-surface-container text-secondary">
              via {c.email_platform}
            </span>
          )}
        </div>
        <span className="text-xs text-secondary font-medium">{new Date(c.created_at).toLocaleDateString()}</span>
      </div>

      {/* Campaign name */}
      <div className="mb-1">
        <h3
          className="text-base font-extrabold text-on-surface hover:text-[#b0004a] transition-colors flex items-center gap-2"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          {c.name}
          {c.include_screenshot && (
            <span className="material-symbols-outlined text-[14px] text-secondary">image</span>
          )}
        </h3>
      </div>

      {/* Subject preview */}
      {c.template_subject && (
        <p className="text-sm text-secondary truncate mb-2">{c.template_subject}</p>
      )}

      {/* Follow-up badge */}
      {(c.step_count ?? 0) > 0 && (
        <div className="inline-flex items-center gap-1 text-xs font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full mb-3">
          <span className="material-symbols-outlined text-[13px]">schedule_send</span>
          {c.step_count} follow-up{c.step_count !== 1 ? 's' : ''}
        </div>
      )}

      {/* Metrics — always visible */}
      <div className="flex items-center gap-5 my-3">
        <div className="text-center">
          <p className={`text-lg font-extrabold ${hasLeads ? 'text-on-surface' : 'text-error'}`} style={{ fontFamily: 'Manrope, sans-serif' }}>
            {c.lead_count ?? 0}
          </p>
          <p className="text-xs text-secondary font-medium">leads</p>
        </div>
        <div className="w-px h-8 bg-slate-100" />
        <div className="text-center">
          <p className={`text-lg font-extrabold ${c.total_sent > 0 ? 'text-blue-600' : 'text-slate-300'}`} style={{ fontFamily: 'Manrope, sans-serif' }}>{c.total_sent}</p>
          <p className="text-xs text-secondary font-medium">sent</p>
        </div>
        <div className="w-px h-8 bg-slate-100" />
        <div className="text-center">
          <p className={`text-lg font-extrabold ${c.total_replied > 0 ? 'text-[#006630]' : 'text-slate-300'}`} style={{ fontFamily: 'Manrope, sans-serif' }}>{c.total_replied}</p>
          <p className="text-xs text-secondary font-medium">replied{c.total_sent > 0 ? ` (${replyRate}%)` : ''}</p>
        </div>
        <div className="w-px h-8 bg-slate-100" />
        <div className="text-center">
          <p className={`text-lg font-extrabold ${c.total_bounced > 0 ? 'text-error' : 'text-slate-300'}`} style={{ fontFamily: 'Manrope, sans-serif' }}>{c.total_bounced}</p>
          <p className="text-xs text-secondary font-medium">bounced</p>
        </div>
        {!hasLeads && c.status === 'draft' && (
          <span className="ml-2 text-xs font-bold text-amber-600 flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px]">warning</span>
            No leads assigned
          </span>
        )}
      </div>

      {/* Progress bar — direct Gmail mode */}
      {isThisSending && !c.platform_campaign_id && sendProgress && sendProgress.total > 0 && (
        <div className="mb-4">
          <div className="flex justify-between text-xs font-semibold text-secondary mb-1.5">
            <span>{sendProgress.sent + sendProgress.failed} / {sendProgress.total}</span>
            <span>{sendProgress.sent} sent{sendProgress.failed > 0 ? `, ${sendProgress.failed} failed` : ''}</span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-1.5">
            <div
              className="primary-gradient h-1.5 rounded-full transition-all"
              style={{ width: `${Math.round(((sendProgress.sent + sendProgress.failed) / sendProgress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Progress bar — platform mode */}
      {isThisSending && c.platform_campaign_id && c.total_sent > 0 && (
        <div className="mb-4">
          <div className="flex justify-between text-xs font-semibold text-secondary mb-1.5">
            <span>Sending via {c.email_platform || 'platform'}</span>
            <span>{c.total_sent} / {c.lead_count}</span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-1.5">
            <div
              className="primary-gradient h-1.5 rounded-full transition-all"
              style={{ width: `${Math.min(100, Math.round((c.total_sent / Math.max(c.lead_count, 1)) * 100))}%` }}
            />
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center gap-3 pt-4 border-t border-slate-50" onClick={(e) => e.stopPropagation()}>
        {canLaunch && (
          <button
            onClick={() => onLaunch(c.id)}
            className="flex items-center gap-2 px-4 py-2 primary-gradient text-on-primary rounded-lg text-sm font-bold ambient-shadow hover:scale-[1.02] transition-transform"
          >
            <span className="material-symbols-outlined text-[16px]">rocket_launch</span>
            Launch Campaign
          </button>
        )}

        {isThisSending && (
          <span className="text-sm font-bold text-blue-600 flex items-center gap-1.5">
            <Loader2 size={13} className="animate-spin" /> Sending…
          </span>
        )}

        {(c.status === 'sent' || c.status === 'completed') && (
          <span className="text-sm font-bold text-[#006630] flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[16px]">check_circle</span>
            Completed
          </span>
        )}

        {/* Overflow menu */}
        <div className="ml-auto relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-2 text-secondary hover:text-on-surface rounded-lg hover:bg-surface-container transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">more_horiz</span>
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 bg-surface-container-lowest rounded-xl ambient-shadow border border-slate-100 py-1 w-44">
                <button
                  onClick={() => { onViewDetail(c); setMenuOpen(false); }}
                  className="w-full text-left px-4 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container flex items-center gap-2 transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px] text-secondary">open_in_new</span>
                  View Details
                </button>
                <button
                  onClick={handleDuplicate}
                  disabled={duplicating}
                  className="w-full text-left px-4 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container flex items-center gap-2 disabled:opacity-50 transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px] text-secondary">content_copy</span>
                  {duplicating ? 'Duplicating…' : 'Duplicate'}
                </button>
                {!isThisSending && (
                  <button
                    onClick={() => { onDelete(c.id, c.name); setMenuOpen(false); }}
                    disabled={deletingId === c.id}
                    className="w-full text-left px-4 py-2 text-sm font-bold text-error hover:bg-red-50 flex items-center gap-2 disabled:opacity-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                    {deletingId === c.id ? 'Deleting…' : 'Delete'}
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

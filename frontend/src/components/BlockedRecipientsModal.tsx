'use client';

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import api from '../api/client';
import type { BlockedRecipient, BlockedSummary } from '../lib/sendBlocked';

interface Props {
  campaignId: string;
  campaignName: string;
  recipients: BlockedRecipient[];
  summary: BlockedSummary;
  message: string;
  onClose: () => void;
  /** Called after a remediation succeeded, so the caller can retry the launch. */
  onRemediated: (note: string) => void;
}

const REASON_COPY: Record<BlockedRecipient['reason'], { label: string; blurb: string; classes: string }> = {
  invalid: {
    label: 'Invalid',
    blurb: 'A verifier confirmed the mailbox does not exist. Sending would bounce and cost sender reputation.',
    classes: 'bg-red-50 text-error border-red-200',
  },
  unverified: {
    label: 'Not verified',
    blurb: 'No verifier has checked this address. Sending blind is the fastest way to lose a warmed domain.',
    classes: 'bg-slate-100 text-slate-700 border-slate-200',
  },
};

/**
 * The remediation surface for a refused launch.
 *
 * Operations' complaint was precise: a campaign failed, and there was no way
 * to see or remove the recipients causing it. So this lists exactly who was
 * blocked and why, and offers the two moves that actually resolve it — drop
 * them, or verify them — rather than a dead-end error toast.
 */
export default function BlockedRecipientsModal({
  campaignId, campaignName, recipients, summary, message, onClose, onRemediated,
}: Props) {
  const [busy, setBusy] = useState<'remove' | 'verify' | null>(null);
  const [error, setError] = useState('');

  const grouped = useMemo(() => ({
    invalid: recipients.filter((r) => r.reason === 'invalid'),
    unverified: recipients.filter((r) => r.reason === 'unverified'),
  }), [recipients]);

  const removeBlocked = async () => {
    setBusy('remove');
    setError('');
    try {
      // blockedOnly makes the SERVER recompute which pending recipients the
      // gate would refuse, so this can't act on a stale list if a verification
      // landed between the refusal and the click.
      const res = await api.delete(`/campaigns/${campaignId}/leads`, { data: { blockedOnly: true } });
      const removed = res.data?.data?.removed ?? 0;
      onRemediated(`Removed ${removed} unsendable recipient${removed === 1 ? '' : 's'} from "${campaignName}". Launch again when ready.`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove those recipients.');
    } finally {
      setBusy(null);
    }
  };

  const verifyBlocked = async () => {
    setBusy('verify');
    setError('');
    try {
      const leadIds = recipients.map((r) => r.leadId);
      const res = await api.post('/verify', { leadIds, emailField: 'all' });
      const total = res.data?.data?.total ?? 0;
      onRemediated(
        total > 0
          ? `Verification started for ${total} address${total === 1 ? '' : 'es'}. Watch it on the Lead Matrix, then launch again — anything still invalid will need removing.`
          : 'Nothing left to verify — try launching again.',
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start verification.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col ambient-shadow">

        <div className="px-6 py-4 border-b border-slate-100 flex items-start gap-3">
          <span className="material-symbols-outlined text-error text-[22px] mt-0.5">block</span>
          <div className="flex-1 min-w-0">
            <h2 className="font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Launch held back &mdash; {summary.total} recipient{summary.total === 1 ? '' : 's'} can&apos;t be emailed
            </h2>
            <p className="text-xs text-secondary mt-0.5">{campaignName}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600 p-1 -mr-1">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-5">
          <p className="text-sm text-secondary">{message}</p>

          {(['invalid', 'unverified'] as const).map((reason) => {
            const rows = grouped[reason];
            if (rows.length === 0) return null;
            const copy = REASON_COPY[reason];
            return (
              <div key={reason}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`px-2 py-0.5 rounded-full border text-[11px] font-bold ${copy.classes}`}>
                    {copy.label} &middot; {rows.length}
                  </span>
                </div>
                <p className="text-xs text-secondary mb-2">{copy.blurb}</p>
                <div className="rounded-xl border border-slate-100 divide-y divide-slate-50 max-h-56 overflow-y-auto">
                  {rows.map((r) => (
                    <div key={r.campaignLeadId} className="px-3 py-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-on-surface truncate">
                          {r.companyName || 'Unnamed lead'}
                        </p>
                        <p className="text-xs text-secondary truncate">{r.email || 'no address'}</p>
                      </div>
                      <a
                        href={`/leads/${r.leadId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] font-bold text-[#b0004a] hover:underline whitespace-nowrap"
                      >
                        Open lead
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="bg-surface-container rounded-xl p-3 text-[11px] text-secondary leading-relaxed">
            <p className="font-bold text-on-surface mb-1">Which verdicts are safe to send to?</p>
            <p><strong>Valid</strong> &mdash; send freely.</p>
            <p><strong>Catch-all</strong> &mdash; the domain accepts any address, so a bounce won&apos;t tell you it was wrong. Send, but keep volume low and watch replies.</p>
            <p><strong>Unknown</strong> &mdash; the verifier couldn&apos;t decide. Not advisable; treat as unverified.</p>
            <p><strong>Not verified / Invalid</strong> &mdash; never send. That&apos;s what this screen is about.</p>
          </div>

          {error && (
            <p className="text-sm text-error bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-full text-sm font-bold text-secondary hover:text-on-surface transition-colors"
          >
            Cancel
          </button>
          {summary.unverified > 0 && (
            <button
              onClick={verifyBlocked}
              disabled={busy !== null}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-full text-sm font-bold bg-surface-container text-on-surface hover:bg-surface-container-high disabled:opacity-40 transition-colors"
            >
              {busy === 'verify'
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <span className="material-symbols-outlined text-[18px]">verified_user</span>}
              Verify these {summary.total}
            </button>
          )}
          <button
            onClick={removeBlocked}
            disabled={busy !== null}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold primary-gradient text-on-primary ambient-shadow disabled:opacity-40 transition-transform hover:scale-[1.02]"
          >
            {busy === 'remove'
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <span className="material-symbols-outlined text-[18px]">playlist_remove</span>}
            Remove &amp; keep the rest
          </button>
        </div>
      </div>
    </div>
  );
}

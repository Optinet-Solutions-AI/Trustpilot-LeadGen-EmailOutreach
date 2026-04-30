import { useState } from 'react';
import type { Lead, LinkStatus } from '../types/lead';

interface Props {
  lead: Pick<Lead, 'id' | 'trustpilot_url' | 'link_status' | 'last_validated_at' | 'link_validation_error'>;
  onDismiss: (id: string) => Promise<void> | void;
  onEditUrl: (id: string, url: string) => Promise<void> | void;
}

const COPY: Record<Exclude<LinkStatus, 'VALID'>, { label: string; tooltip: string; tone: string }> = {
  FLAGGED_DEAD: {
    label: 'dead link',
    tooltip:
      'Trustpilot returned a 404 or 410 for this URL — the profile no longer exists.\n\n' +
      'If the link still works in your browser, that means our request got through but yours got bot-blocked the other way. Re-run Validate Links to confirm.',
    tone: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  },
  FLAGGED_REMOVED: {
    label: 'profile removed',
    tooltip:
      'Trustpilot returned 200 OK but the page contains "this profile has been removed" or similar copy. Usually means the company asked Trustpilot to delist it.',
    tone: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  },
  UNKNOWN: {
    label: 'couldn\'t verify',
    tooltip:
      "We couldn't tell whether this URL is alive or dead. Most common cause: Trustpilot's Cloudflare bot-protection blocked our check (403/429), or the request timed out.\n\n" +
      'The profile is probably fine — re-run Validate Links later to retry. UNKNOWN is never the same as DEAD.',
    tone: 'bg-slate-50 text-slate-600 ring-1 ring-slate-200',
  },
};

export default function LeadLinkWarning({ lead, onDismiss, onEditUrl }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(lead.trustpilot_url || '');
  const [busy, setBusy] = useState(false);

  if (lead.link_status === 'VALID') return null;
  const copy = COPY[lead.link_status];
  const tooltip = lead.link_validation_error
    ? `${copy.tooltip}\n\nError: ${lead.link_validation_error}`
    : copy.tooltip;

  const handleDismiss = async () => {
    setBusy(true);
    try {
      await onDismiss(lead.id);
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (!draft.trim() || draft.trim() === lead.trustpilot_url) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onEditUrl(lead.id, draft.trim());
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="inline-flex items-center gap-1.5 mt-1"
      onClick={(e) => e.stopPropagation()}
    >
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${copy.tone}`}
        title={tooltip}
      >
        <span className="material-symbols-outlined text-[10px]">warning</span>
        {copy.label}
      </span>

      {editing ? (
        <span className="inline-flex items-center gap-1">
          <input
            type="url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            className="text-[11px] px-1.5 py-0.5 rounded border border-slate-300 w-[220px] focus:ring-1 focus:ring-[#b0004a] focus:outline-none"
            placeholder="https://www.trustpilot.com/review/…"
          />
          <button
            onClick={handleSave}
            disabled={busy}
            className="text-[10px] font-bold text-white bg-[#b0004a] hover:bg-[#8c003b] px-2 py-0.5 rounded disabled:opacity-50"
          >
            save
          </button>
          <button
            onClick={() => { setEditing(false); setDraft(lead.trustpilot_url || ''); }}
            disabled={busy}
            className="text-[10px] text-secondary hover:text-on-surface px-1"
          >
            cancel
          </button>
        </span>
      ) : (
        <span className="inline-flex items-center gap-2">
          <button
            onClick={handleDismiss}
            disabled={busy}
            className="text-[10px] font-semibold text-slate-500 hover:text-on-surface underline-offset-2 hover:underline disabled:opacity-50"
            title="Mark this URL as valid (won't be flagged again)"
          >
            dismiss
          </button>
          <button
            onClick={() => setEditing(true)}
            disabled={busy}
            className="text-[10px] font-semibold text-[#b0004a] hover:underline underline-offset-2 disabled:opacity-50"
            title="Edit the Trustpilot URL and re-validate"
          >
            edit link
          </button>
        </span>
      )}
    </div>
  );
}

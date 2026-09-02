'use client';

/**
 * Edit an existing campaign in place.
 *
 * Before this, a campaign was write-once: the wizard could only create, so a
 * typo in the subject or a wrong daily cap meant duplicating the campaign and
 * deleting the original. This edits the fields that are safe to change after
 * creation — the copy, the screenshot toggle, and the sending window.
 *
 * Deliberately NOT editable here: the recipient list (leads are assigned rows
 * in campaign_leads with their own send state, so changing them is a different
 * operation) and status (that's what Launch / Stop do).
 *
 * Editing a campaign that has already sent changes only what goes out NEXT —
 * mail already delivered is untouched — so the modal says so plainly.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Campaign } from '../types/campaign';
import { TIMEZONES, HOURS, DAY_LABELS, type SendingSchedule } from './campaign-wizard/scheduleConfig';
import EmailPreviewModal, { type PreviewStep } from './EmailPreviewModal';

interface Props {
  campaign: Campaign;
  onSave: (patch: Partial<Campaign>) => Promise<void>;
  onClose: () => void;
}

const DEFAULT_SCHEDULE: SendingSchedule = {
  timezone: 'Asia/Manila',
  startHour: '09:00',
  endHour: '17:00',
  days: [1, 2, 3, 4, 5],
  dailyLimit: 50,
};

export default function CampaignEditModal({ campaign, onSave, onClose }: Props) {
  const [name, setName]                           = useState(campaign.name);
  const [subject, setSubject]                     = useState(campaign.template_subject ?? '');
  const [body, setBody]                           = useState(campaign.template_body ?? '');
  const [includeScreenshot, setIncludeScreenshot] = useState(campaign.include_screenshot);
  const [schedule, setSchedule]                   = useState<SendingSchedule>(
    (campaign.sending_schedule as SendingSchedule | null) ?? DEFAULT_SCHEDULE,
  );

  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, saving]);

  const hasSent  = campaign.total_sent > 0;
  const isLive   = campaign.status === 'sending';
  const canSave  = name.trim().length > 0 && subject.trim().length > 0 && body.trim().length > 0;

  const dirty =
    name !== campaign.name ||
    subject !== (campaign.template_subject ?? '') ||
    body !== (campaign.template_body ?? '') ||
    includeScreenshot !== campaign.include_screenshot ||
    JSON.stringify(schedule) !== JSON.stringify(campaign.sending_schedule ?? DEFAULT_SCHEDULE);

  const toggleDay = (d: number) => {
    setSchedule((prev) => ({
      ...prev,
      days: prev.days.includes(d) ? prev.days.filter((x) => x !== d) : [...prev.days, d].sort(),
    }));
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      // Column names, not camelCase — PATCH /api/campaigns/:id writes the
      // body straight through to the campaigns table.
      await onSave({
        name: name.trim(),
        template_subject: subject,
        template_body: body,
        include_screenshot: includeScreenshot,
        sending_schedule: schedule,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the campaign.');
      setSaving(false);
    }
  };

  const previewSteps: PreviewStep[] = [{ label: 'Initial email', subject, body }];

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:p-4">
      <div className="bg-surface-container-lowest rounded-t-2xl sm:rounded-2xl ambient-shadow w-full max-w-2xl border-t sm:border border-slate-100 max-h-[92vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <div>
            <h2 className="text-lg font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Edit Campaign
            </h2>
            <p className="text-xs text-secondary mt-0.5 truncate max-w-[26rem]">{campaign.name}</p>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            className="p-1.5 text-secondary hover:text-on-surface rounded-lg hover:bg-surface-container disabled:opacity-40 transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          {(hasSent || isLive) && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-800">
              <span className="material-symbols-outlined text-[16px]">warning</span>
              <span>
                {isLive
                  ? 'This campaign is sending right now. Edits apply to emails that have not gone out yet.'
                  : `${campaign.total_sent} email${campaign.total_sent === 1 ? ' has' : 's have'} already been sent. Edits only affect what sends from here on.`}
              </span>
            </div>
          )}

          <div>
            <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
              Campaign Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
              Subject Line
            </label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm font-mono border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider">
                Email Body (HTML)
              </label>
              <button
                onClick={() => setShowPreview(true)}
                disabled={!subject.trim() && !body.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-[#b0004a] bg-[#ffd9de]/50 hover:bg-[#ffd9de] disabled:opacity-40 transition-colors"
              >
                <span className="material-symbols-outlined text-[15px]">visibility</span>
                Preview email
              </button>
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm font-mono border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none resize-none"
            />
            <p className="text-[10px] text-secondary mt-1.5">
              Tokens like <code className="bg-surface-container px-1 rounded">{'{{company_name}}'}</code> and
              spintax <code className="bg-surface-container px-1 rounded">{'{Hi|Hello}'}</code> both work here.
            </p>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={includeScreenshot}
              onChange={(e) => setIncludeScreenshot(e.target.checked)}
              className="w-4 h-4 rounded accent-[#b0004a]"
            />
            <span className="text-sm font-semibold text-on-surface">Attach the lead&apos;s profile screenshot</span>
          </label>

          {/* Schedule */}
          <div className="border-t border-slate-100 pt-4 space-y-3">
            <p className="text-xs font-extrabold text-secondary uppercase tracking-wider">Sending Window</p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-bold text-secondary mb-1.5">Timezone</label>
                <select
                  value={schedule.timezone}
                  onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })}
                  className="w-full bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                >
                  {TIMEZONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-secondary mb-1.5">Daily Limit</label>
                <input
                  type="number"
                  min={1}
                  value={schedule.dailyLimit}
                  onChange={(e) => setSchedule({ ...schedule, dailyLimit: Math.max(1, Number(e.target.value) || 1) })}
                  className="w-full bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-secondary mb-1.5">Start Hour</label>
                <select
                  value={schedule.startHour}
                  onChange={(e) => setSchedule({ ...schedule, startHour: e.target.value })}
                  className="w-full bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                >
                  {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-secondary mb-1.5">End Hour</label>
                <select
                  value={schedule.endHour}
                  onChange={(e) => setSchedule({ ...schedule, endHour: e.target.value })}
                  className="w-full bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                >
                  {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-secondary mb-1.5">Sending Days</label>
              <div className="flex gap-1.5 flex-wrap">
                {DAY_LABELS.map((label, d) => (
                  <button
                    key={label}
                    onClick={() => toggleDay(d)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                      schedule.days.includes(d)
                        ? 'primary-gradient text-on-primary'
                        : 'bg-surface-container text-secondary hover:bg-surface-container-high'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {schedule.days.length === 0 && (
                <p className="text-[10px] text-amber-700 font-semibold mt-1.5">
                  No days selected — nothing will send until you pick at least one.
                </p>
              )}
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-[#ffd9de] border border-[#b0004a]/20 rounded-xl text-xs text-[#b0004a] font-semibold">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-end gap-2 flex-shrink-0">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-5 py-2.5 rounded-xl text-sm font-bold border border-slate-200 text-secondary hover:bg-surface-container disabled:opacity-40 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || !dirty || saving}
            className="flex items-center gap-2 px-5 py-2.5 primary-gradient text-on-primary rounded-xl text-sm font-bold ambient-shadow hover:scale-[1.02] disabled:opacity-40 disabled:hover:scale-100 transition-transform"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <span className="material-symbols-outlined text-[16px]">save</span>}
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {showPreview && (
        <EmailPreviewModal
          steps={previewSteps}
          includeScreenshot={includeScreenshot}
          campaignId={campaign.id}
          language={undefined}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}

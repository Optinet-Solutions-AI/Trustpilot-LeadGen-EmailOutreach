'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { COUNTRIES, CATEGORIES, TIMEZONES, DAY_LABELS, resolveOutreachLanguage, type SendingSchedule } from './scheduleConfig';
import EmailPreviewModal, { type PreviewStep } from '../EmailPreviewModal';
import type { FollowUpStepInput } from '../../types/campaign';

interface Props {
  name: string;
  subject: string;
  body: string;
  includeScreenshot: boolean;
  filterCountry: string;
  filterCategory: string;
  /** Explicit outreach language, or '' to derive from filterCountry. */
  filterLanguage: string;
  /** Platform this campaign targets — always a slug ('trustpilot' |
   *  'tripadvisor' | 'yelp'); the wizard no longer offers "all platforms".
   *  Shown in the recipient summary so the operator sees "Yelp · US ·
   *  plumbing" instead of just "US · plumbing". */
  filterPlatform?: string;
  recipientCount: number;
  followUpCount: number;
  /** Full follow-up bodies, so the final review can preview the whole
   *  sequence rather than just the count. */
  followUpSteps?: FollowUpStepInput[];
  /** Leads picked in Step 1 — the preview renders against real rows. */
  selectedLeadIds?: string[];
  schedule: SendingSchedule;
  saving: boolean;
  onSubmit: () => void;
}

const PLATFORM_LABELS: Record<string, string> = {
  trustpilot: 'Trustpilot',
  tripadvisor: 'TripAdvisor',
  yelp: 'Yelp',
  booking: 'Booking.com',
};

export default function WizardStep4Launch({
  name, subject, body, includeScreenshot,
  filterCountry, filterCategory, filterLanguage, filterPlatform,
  recipientCount, followUpCount, followUpSteps = [], selectedLeadIds = [], schedule,
  saving, onSubmit,
}: Props) {
  const [showFullPreview, setShowFullPreview] = useState(false);
  const countryName  = COUNTRIES.find((c) => c.code === filterCountry)?.name  || 'All Countries';
  const categoryName = CATEGORIES.find((c) => c.slug === filterCategory)?.name || 'All Categories';
  const platformName = filterPlatform ? (PLATFORM_LABELS[filterPlatform] ?? filterPlatform) : '';
  const tzLabel      = TIMEZONES.find((t) => t.value === schedule.timezone)?.label.split('—')[0].trim() || schedule.timezone;
  const activeDays   = schedule.days.map((d) => DAY_LABELS[d]).join(', ') || 'None';
  const bodyPreview  = body.replace(/<[^>]+>/g, '').slice(0, 200).trim();

  const senderCount = (schedule.senderAccountIds?.length ?? 0) || (schedule.senderAccountId ? 1 : 0);

  // Last chance to read the real email before the campaign is created.
  const previewSteps: PreviewStep[] = [
    { label: 'Initial email', subject, body },
    ...followUpSteps.map((s, i) => ({ label: `Follow-up #${i + 1}`, subject: s.subject, body: s.body })),
  ];
  const pinnedSenderId = schedule.senderAccountIds?.find((id) => id !== '__env__') ?? schedule.senderAccountId;
  const canPreview = subject.trim().length > 0 || body.trim().length > 0;

  const checks = [
    { ok: name.trim().length > 0,         label: 'Campaign name set',                  icon: 'badge' },
    { ok: recipientCount > 0,             label: `${recipientCount} recipients selected`, icon: 'group' },
    { ok: subject.trim().length > 0,      label: 'Subject line written',                icon: 'subject' },
    { ok: body.trim().length > 0,         label: 'Email body written',                  icon: 'edit_note' },
    { ok: senderCount > 0,               label: senderCount > 0 ? `${senderCount} sender account${senderCount !== 1 ? 's' : ''} selected` : 'No sender account selected', icon: 'alternate_email' },
    { ok: schedule.days.length > 0,       label: 'Sending days configured',             icon: 'event' },
    { ok: schedule.dailyLimit > 0,        label: `Daily limit: ${schedule.dailyLimit}`, icon: 'speed' },
  ];

  const allGood = checks.every((c) => c.ok);

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-6 py-5 sm:py-10">

      {/* Headline */}
      <div className="text-center mb-6 sm:mb-10">
        <h1 className="text-xl sm:text-3xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Review &amp; Launch
        </h1>
        <p className="text-secondary text-xs sm:text-sm">
          Everything looks good? Create the campaign as a draft — then send a test flight before going live.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4 sm:gap-6">

        {/* ── Left: summary cards ── */}
        <div className="space-y-4">

          {/* Campaign Overview */}
          <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
            <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100 bg-surface-container">
              <div className="w-7 h-7 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
                <span className="material-symbols-outlined text-on-primary text-[14px]">campaign</span>
              </div>
              <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Campaign Overview
              </p>
            </div>
            <div className="divide-y divide-slate-50">
              <div className="px-6 py-3 flex items-start gap-3">
                <span className="material-symbols-outlined text-[15px] text-secondary mt-0.5">badge</span>
                <div>
                  <p className="text-[10px] font-bold text-secondary uppercase tracking-wider">Name</p>
                  <p className="text-sm font-semibold text-on-surface mt-0.5">{name || <span className="text-slate-300 italic">Not set</span>}</p>
                </div>
              </div>
              <div className="px-6 py-3 flex items-start gap-3">
                <span className="material-symbols-outlined text-[15px] text-secondary mt-0.5">group</span>
                <div>
                  <p className="text-[10px] font-bold text-secondary uppercase tracking-wider">Recipients</p>
                  <p className="text-sm font-semibold text-[#b0004a] mt-0.5">
                    {recipientCount.toLocaleString()} lead{recipientCount !== 1 ? 's' : ''}
                  </p>
                  {(filterCountry || filterCategory || platformName) && (
                    <p className="text-xs text-secondary mt-0.5">
                      {[platformName, filterCountry ? countryName : '', filterCategory ? categoryName : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </div>
              </div>
              <div className="px-6 py-3 flex items-start gap-3">
                <span className="material-symbols-outlined text-[15px] text-secondary mt-0.5">subject</span>
                <div>
                  <p className="text-[10px] font-bold text-secondary uppercase tracking-wider">Subject Line</p>
                  <p className="text-sm font-semibold text-on-surface mt-0.5 line-clamp-2">
                    {subject || <span className="text-slate-300 italic">Not set</span>}
                  </p>
                </div>
              </div>
              <div className="px-6 py-3 flex items-start gap-3">
                <span className="material-symbols-outlined text-[15px] text-secondary mt-0.5">edit_note</span>
                <div>
                  <p className="text-[10px] font-bold text-secondary uppercase tracking-wider">Body Preview</p>
                  <p className="text-sm text-secondary mt-0.5 line-clamp-3">
                    {bodyPreview
                      ? (bodyPreview + (body.length > 200 ? '…' : ''))
                      : <span className="text-slate-300 italic">Not set</span>}
                  </p>
                  <button
                    onClick={() => setShowFullPreview(true)}
                    disabled={!canPreview}
                    className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-[#b0004a] bg-[#ffd9de]/50 hover:bg-[#ffd9de] disabled:opacity-40 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[15px]">visibility</span>
                    Preview the real email
                  </button>
                </div>
              </div>
              {followUpCount > 0 && (
                <div className="px-6 py-3 flex items-start gap-3">
                  <span className="material-symbols-outlined text-[15px] text-secondary mt-0.5">schedule_send</span>
                  <div>
                    <p className="text-[10px] font-bold text-secondary uppercase tracking-wider">Follow-up Sequence</p>
                    <p className="text-sm font-semibold text-on-surface mt-0.5">
                      {followUpCount} follow-up email{followUpCount !== 1 ? 's' : ''} configured
                    </p>
                    <p className="text-xs text-secondary mt-0.5">Auto-sent to non-replies</p>
                  </div>
                </div>
              )}
              {includeScreenshot && (
                <div className="px-6 py-3 bg-[#ffd9de]/20 flex items-center gap-3">
                  <span className="material-symbols-outlined text-[#b0004a] text-[15px]">screenshot_monitor</span>
                  <p className="text-xs font-bold text-[#b0004a]">Trustpilot screenshot attached to each email</p>
                </div>
              )}
            </div>
          </div>

          {/* Sending Schedule */}
          <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
            <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100 bg-surface-container">
              <div className="w-7 h-7 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
                <span className="material-symbols-outlined text-on-primary text-[14px]">schedule</span>
              </div>
              <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Sending Schedule
              </p>
            </div>
            <div className="px-4 sm:px-6 py-4 grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6">
              {[
                { label: 'Timezone',     value: tzLabel },
                { label: 'Window',       value: `${schedule.startHour} – ${schedule.endHour}` },
                { label: 'Active Days',  value: activeDays },
                { label: 'Daily Limit',  value: `${schedule.dailyLimit} emails / day` },
                { label: 'Senders',      value: senderCount > 0 ? `${senderCount} account${senderCount !== 1 ? 's' : ''} (round-robin)` : 'None selected' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <p className="text-[10px] font-bold text-secondary uppercase tracking-wider">{label}</p>
                  <p className="text-sm font-semibold text-on-surface mt-0.5">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: checklist + launch button ── */}
        <div className="space-y-4">

          {/* Pre-launch checklist */}
          <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 bg-surface-container">
              <span className="material-symbols-outlined text-[16px] text-[#b0004a]">checklist</span>
              <p className="text-xs font-extrabold text-on-surface uppercase tracking-wider">Pre-launch Checklist</p>
            </div>
            <div className="p-4 space-y-2">
              {checks.map((c) => (
                <div key={c.label} className="flex items-center gap-3">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                    c.ok ? 'bg-[#8ff9a8]/30' : 'bg-error/10'
                  }`}>
                    <span className={`material-symbols-outlined text-[13px] ${c.ok ? 'text-[#006630]' : 'text-error'}`}>
                      {c.ok ? 'check' : 'close'}
                    </span>
                  </div>
                  <p className={`text-xs font-semibold ${c.ok ? 'text-on-surface' : 'text-error'}`}>{c.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Launch button */}
          <button
            type="button"
            onClick={onSubmit}
            disabled={saving || !allGood}
            className="w-full flex items-center justify-center gap-2 primary-gradient text-on-primary px-5 py-4 rounded-2xl text-sm font-extrabold ambient-shadow hover:scale-[1.01] disabled:opacity-50 disabled:scale-100 transition-transform"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            {saving ? (
              <><Loader2 size={16} className="animate-spin" /> Creating Campaign...</>
            ) : (
              <>
                <span className="material-symbols-outlined text-[20px]">rocket_launch</span>
                Create Campaign
              </>
            )}
          </button>

          <div className="bg-surface-container rounded-xl p-4 text-[11px] text-secondary leading-relaxed space-y-2">
            <div className="flex items-start gap-2">
              <span className="material-symbols-outlined text-[14px] text-[#b0004a] flex-shrink-0 mt-0.5">info</span>
              <p>Campaign created as a <span className="font-bold text-on-surface">Draft</span>. No emails sent yet.</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="material-symbols-outlined text-[14px] text-[#b0004a] flex-shrink-0 mt-0.5">science</span>
              <p>Send a <span className="font-bold text-on-surface">Test Flight</span> to verify your email looks correct before going live.</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="material-symbols-outlined text-[14px] text-[#b0004a] flex-shrink-0 mt-0.5">send</span>
              <p>Click <span className="font-bold text-on-surface">Launch</span> on the campaign card when ready to go live.</p>
            </div>
          </div>

        </div>
      </div>

      {showFullPreview && (
        <EmailPreviewModal
          steps={previewSteps}
          includeScreenshot={includeScreenshot}
          recipients={selectedLeadIds.map((id) => ({ id }))}
          senderAccountId={pinnedSenderId}
          language={resolveOutreachLanguage(filterCountry, filterLanguage)}
          onClose={() => setShowFullPreview(false)}
        />
      )}
    </div>
  );
}

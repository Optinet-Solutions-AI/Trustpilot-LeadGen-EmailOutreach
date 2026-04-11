'use client';

import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import StepSetup from './StepSetup';
import StepTemplate from './StepTemplate';
import StepFollowUps from './StepFollowUps';
import StepRecipients from './StepRecipients';
import StepReview from './StepReview';
import type { FollowUpStepInput } from '../../types/campaign';
import { DEFAULT_SCHEDULE, type SendingSchedule } from './StepSetup';

const DEFAULT_SUBJECT = '{Your Trustpilot rating needs attention|A quick note about your online reputation|Trustpilot improvement opportunity}, {{company_name}}';

const DEFAULT_BODY = `<p>{Hi|Hello|Hey},</p>

<p>{We recently noticed|I came across|Our team spotted} your brand's Trustpilot {score|rating|profile} {isn't where it should be|could use some improvement|has room for growth}, with a {relatively low|below-average} overall rating (see details below). {Our team can help you|We specialize in helping businesses} {improve your|boost your|strengthen your} Trustpilot score by {boosting positive visibility|increasing positive review volume}, {achieving a green rating|reaching a higher star rating}, and {enhancing your brand's credibility and trustworthy online image|building stronger customer trust online}.</p>

<p><strong>{{company_name}}</strong><br>
Trustpilot Rating: {{star_rating}} ★</p>

<p>{Would you be open to a quick chat|Could we schedule a brief call|Would a short conversation work for you} to {see how we can|discuss how to|explore ways to} {clean up your Trustpilot presence|improve your online reputation|boost your review profile} and {strengthen your online reputation|drive more customer trust}?</p>

<p>{Best regards|Kind regards|Best},<br>
OptiRate</p>
<p>www.optiratesolutions.com</p>`;

const STEPS = [
  { label: 'Setup',      icon: 'tune',          sub: 'Name & audience' },
  { label: 'Template',   icon: 'edit_note',      sub: 'Subject & body' },
  { label: 'Follow-ups', icon: 'schedule_send',  sub: 'Sequences' },
  { label: 'Recipients', icon: 'group',          sub: 'Select leads' },
  { label: 'Review',     icon: 'fact_check',     sub: 'Confirm & create' },
];

interface Props {
  onClose: () => void;
  onCreate: (data: {
    name: string;
    templateSubject: string;
    templateBody: string;
    includeScreenshot: boolean;
    leadIds: string[];
    followUpSteps?: FollowUpStepInput[];
    sendingSchedule?: SendingSchedule;
  }) => Promise<void>;
}

/** Resolves spintax for the live preview */
function resolveSpintax(text: string): string {
  let result = text;
  let max = 50;
  while (max-- > 0) {
    const match = result.match(/\{([^{}]+)\}/);
    if (!match) break;
    const options = match[1].split('|');
    result = result.replace(match[0], options[0]); // always pick first for stable preview
  }
  return result;
}

export default function CampaignWizard({ onClose, onCreate }: Props) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  const [name, setName]                     = useState('');
  const [filterCountry, setFilterCountry]   = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [schedule, setSchedule]             = useState<SendingSchedule>(DEFAULT_SCHEDULE);
  const [subject, setSubject]               = useState(DEFAULT_SUBJECT);
  const [body, setBody]                     = useState(DEFAULT_BODY);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [followUpSteps, setFollowUpSteps]   = useState<FollowUpStepInput[]>([]);
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);

  const completedSteps = new Set<number>();
  if (name.trim()) completedSteps.add(0);
  if (subject.trim() && body.trim()) completedSteps.add(1);
  completedSteps.add(2);
  if (selectedLeadIds.length > 0) completedSteps.add(3);

  const canProceed = () => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return subject.trim().length > 0 && body.trim().length > 0;
    if (step === 2) return true;
    if (step === 3) return selectedLeadIds.length > 0;
    return true;
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await onCreate({
        name: name.trim(),
        templateSubject: subject,
        templateBody: body,
        includeScreenshot,
        leadIds: selectedLeadIds,
        followUpSteps: followUpSteps.length > 0 ? followUpSteps : undefined,
        sendingSchedule: schedule,
      });
      onClose();
    } catch {
      setSaving(false);
    }
  };

  // Live preview derived values
  const sampleData: Record<string, string> = {
    company_name: 'Acme Corp',
    website_url: 'acme.com',
    star_rating: '2.5',
    category: filterCategory || 'casino',
    country: filterCountry || 'DE',
  };
  const applyTokens = (t: string) =>
    t.replace(/\{\{(\w+)\}\}/g, (_, k) => sampleData[k] ?? `{{${k}}}`);
  const previewSubject = resolveSpintax(applyTokens(subject));
  const previewBody    = resolveSpintax(applyTokens(body))
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 200);

  return (
    <div className="flex flex-col h-full bg-background">

      {/* ── Top Header ── */}
      <div className="flex items-center justify-between px-10 py-5 bg-surface-container-lowest border-b border-slate-100 ambient-shadow">
        <div className="flex items-center gap-4">
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-secondary hover:text-on-surface hover:bg-surface-container transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          </button>
          <div>
            <h1
              className="text-2xl font-extrabold text-on-surface"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              Create New Campaign
            </h1>
            <p className="text-sm text-secondary font-medium mt-0.5">
              Step {step + 1} of {STEPS.length}: {STEPS[step].sub}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-bold text-secondary border border-slate-200 rounded-lg hover:bg-surface-container transition-colors"
          >
            Save Draft
          </button>
          {step < STEPS.length - 1 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!canProceed()}
              className="flex items-center gap-2 px-5 py-2 primary-gradient text-on-primary text-sm font-bold rounded-lg ambient-shadow hover:scale-[1.02] disabled:opacity-40 disabled:scale-100 transition-transform"
            >
              Continue
              <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={saving || selectedLeadIds.length === 0}
              className="flex items-center gap-2 px-5 py-2 bg-[#006630] text-white text-sm font-bold rounded-lg ambient-shadow hover:scale-[1.02] disabled:opacity-50 disabled:scale-100 transition-transform"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <span className="material-symbols-outlined text-[16px]">rocket_launch</span>}
              {saving ? 'Creating...' : 'Create Campaign'}
            </button>
          )}
        </div>
      </div>

      {/* ── Stepper ── */}
      <div className="bg-surface-container-lowest border-b border-slate-100 px-10">
        <div className="flex items-center py-3">
          {STEPS.map((s, i) => {
            const isActive    = i === step;
            const isCompleted = completedSteps.has(i);
            return (
              <div key={s.label} className="flex items-center flex-1 last:flex-none">
                <button
                  onClick={() => isCompleted || i <= step ? setStep(i) : null}
                  className="flex items-center gap-2.5 group"
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center font-extrabold text-xs transition-all ${
                    isActive    ? 'primary-gradient text-on-primary ambient-shadow scale-110' :
                    isCompleted ? 'bg-[#006630] text-white' :
                                  'bg-surface-container-high text-secondary'
                  }`}>
                    {isCompleted
                      ? <span className="material-symbols-outlined text-[14px]">check</span>
                      : <span>{i + 1}</span>
                    }
                  </div>
                  <div className="text-left">
                    <p className={`text-xs font-extrabold transition-colors ${
                      isActive    ? 'text-[#b0004a]' :
                      isCompleted ? 'text-[#006630]' :
                                    'text-secondary'
                    }`}>
                      {s.label.toUpperCase()}
                    </p>
                    <p className="text-[10px] text-secondary">{s.sub}</p>
                  </div>
                </button>
                {i < STEPS.length - 1 && (
                  <div className={`flex-1 h-0.5 mx-4 rounded-full transition-colors ${
                    isCompleted ? 'bg-[#006630]/40' : 'bg-slate-100'
                  }`} />
                )}
              </div>
            );
          })}
        </div>
        {/* Progress bar */}
        <div className="w-full h-0.5 bg-slate-100 rounded-full mb-1">
          <div
            className="h-0.5 primary-gradient rounded-full transition-all duration-500"
            style={{ width: `${((step) / (STEPS.length - 1)) * 100}%` }}
          />
        </div>
      </div>

      {/* ── Main content + right sidebar ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left: step content */}
        <div className="flex-1 overflow-y-auto px-10 py-8">
          {step === 0 && (
            <StepSetup
              name={name}
              filterCountry={filterCountry}
              filterCategory={filterCategory}
              schedule={schedule}
              onChange={(patch) => {
                if (patch.name !== undefined) setName(patch.name);
                if (patch.filterCountry !== undefined) setFilterCountry(patch.filterCountry);
                if (patch.filterCategory !== undefined) setFilterCategory(patch.filterCategory);
                if (patch.schedule !== undefined) setSchedule(patch.schedule);
              }}
            />
          )}
          {step === 1 && (
            <StepTemplate
              subject={subject}
              body={body}
              includeScreenshot={includeScreenshot}
              filterCountry={filterCountry}
              filterCategory={filterCategory}
              onChange={(patch) => {
                if (patch.subject !== undefined) setSubject(patch.subject);
                if (patch.body !== undefined) setBody(patch.body);
                if (patch.includeScreenshot !== undefined) setIncludeScreenshot(patch.includeScreenshot);
              }}
            />
          )}
          {step === 2 && (
            <StepFollowUps steps={followUpSteps} onChange={setFollowUpSteps} />
          )}
          {step === 3 && (
            <StepRecipients
              filterCountry={filterCountry}
              filterCategory={filterCategory}
              selectedLeadIds={selectedLeadIds}
              onSelectionChange={setSelectedLeadIds}
            />
          )}
          {step === 4 && (
            <StepReview
              name={name}
              subject={subject}
              body={body}
              includeScreenshot={includeScreenshot}
              filterCountry={filterCountry}
              filterCategory={filterCategory}
              recipientCount={selectedLeadIds.length}
              followUpCount={followUpSteps.length}
              saving={saving}
              onSubmit={handleSubmit}
            />
          )}
        </div>

        {/* Right: sidebar */}
        <div className="w-80 flex-shrink-0 border-l border-slate-100 bg-surface-container-lowest overflow-y-auto p-5 space-y-4">

          {/* Dynamic Preview */}
          <div className="bg-surface-container-lowest rounded-xl border border-slate-100 ambient-shadow overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-surface-container">
              <p className="text-xs font-extrabold text-on-surface uppercase tracking-wider">Dynamic Preview</p>
              <span className="text-[10px] font-bold bg-[#8ff9a8]/40 text-[#006630] px-2 py-0.5 rounded-full">LIVE EDIT</span>
            </div>

            {/* Mini email card */}
            <div className="p-4">
              <div className="flex items-center gap-2.5 mb-3">
                <div className="w-8 h-8 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-on-primary text-[14px]">business</span>
                </div>
                <div>
                  <p className="text-xs font-bold text-on-surface">Acme Corp</p>
                  <p className="text-[10px] text-secondary">contact@acme.com</p>
                </div>
              </div>

              <div className="bg-surface-container rounded-lg p-3 mb-3">
                <p className="text-[10px] font-bold text-secondary uppercase tracking-wider mb-1">Subject</p>
                <p className="text-xs font-bold text-on-surface leading-snug line-clamp-2">{previewSubject || 'Your subject will appear here…'}</p>
              </div>

              <div className="text-[11px] text-secondary leading-relaxed line-clamp-5">
                {previewBody || 'Your email body will appear here once you write it in the Template step.'}
              </div>

              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[12px] text-secondary">person</span>
                <p className="text-[10px] text-secondary">Sending as <span className="font-bold text-on-surface">OptiRate</span></p>
              </div>
            </div>
          </div>

          {/* AI Optimization */}
          <div className="bg-[#ffd9de]/30 border border-[#b0004a]/10 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="material-symbols-outlined text-[#b0004a] text-[16px]">auto_awesome</span>
              <p className="text-xs font-extrabold text-[#b0004a] uppercase tracking-wider">AI Optimization</p>
            </div>
            <p className="text-xs text-secondary leading-relaxed mb-3">
              {step === 1
                ? 'Our AI suggests personalizing the first paragraph with a specific recent review mention for higher reply rates.'
                : step === 0
                ? 'Narrow your audience by country + category to increase personalization and reply rates.'
                : step === 3
                ? 'Select leads with ratings between 1–3 stars for the highest conversion rates.'
                : 'Review your spintax variations to ensure all options read naturally before sending.'}
            </p>
            <button className="w-full text-xs font-bold text-[#b0004a] bg-[#ffd9de] hover:bg-[#b0004a] hover:text-white px-3 py-2 rounded-lg transition-colors">
              Apply AI Suggestion
            </button>
          </div>

          {/* Campaign Controls */}
          <div className="bg-surface-container-lowest rounded-xl border border-slate-100 ambient-shadow overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 bg-surface-container">
              <p className="text-xs font-extrabold text-on-surface uppercase tracking-wider">Campaign Controls</p>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-secondary">Active Senders</span>
                <span className="text-xs font-bold text-on-surface">1 Account</span>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-bold text-on-surface">Smart Send</p>
                  <p className="text-[10px] text-secondary">Optimal time per recipient</p>
                </div>
                <div className="w-9 h-5 bg-[#b0004a] rounded-full flex items-center justify-end px-0.5 cursor-pointer">
                  <div className="w-4 h-4 bg-white rounded-full shadow" />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-bold text-on-surface">Auto-stop on Reply</p>
                  <p className="text-[10px] text-secondary">Stops follow-ups when replied</p>
                </div>
                <div className="w-9 h-5 bg-[#b0004a] rounded-full flex items-center justify-end px-0.5 cursor-pointer">
                  <div className="w-4 h-4 bg-white rounded-full shadow" />
                </div>
              </div>
              <div className="pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-secondary">Daily Limit</span>
                  <span className="text-xs font-bold text-on-surface">{schedule.dailyLimit}/day</span>
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-xs font-semibold text-secondary">Send Window</span>
                  <span className="text-xs font-bold text-on-surface">{schedule.startHour}–{schedule.endHour}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Follow-up summary (shows after step 2) */}
          {followUpSteps.length > 0 && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-blue-600 text-[15px]">schedule_send</span>
                <p className="text-xs font-bold text-blue-700">{followUpSteps.length} Follow-up{followUpSteps.length !== 1 ? 's' : ''} Configured</p>
              </div>
              {followUpSteps.map((s, i) => (
                <p key={i} className="text-[11px] text-blue-600 ml-5">
                  Step {i + 2}: after {s.delayDays} day{s.delayDays !== 1 ? 's' : ''}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom navigation bar ── */}
      <div className="flex items-center justify-between px-10 py-4 bg-surface-container-lowest border-t border-slate-100">
        {/* Lead count */}
        <div className="flex items-center gap-2 text-sm text-secondary">
          <span className="material-symbols-outlined text-[16px] text-[#b0004a]">group</span>
          {selectedLeadIds.length > 0
            ? <span><span className="font-extrabold text-[#b0004a]">{selectedLeadIds.length}</span> leads selected for this campaign</span>
            : <span>Targeting leads from Lead Matrix</span>
          }
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => step > 0 ? setStep(step - 1) : onClose()}
            className="flex items-center gap-2 text-sm font-bold text-secondary hover:text-on-surface transition-colors px-4 py-2 rounded-lg hover:bg-surface-container"
          >
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            {step === 0 ? 'Cancel' : 'Previous Step'}
          </button>

          {step < STEPS.length - 1 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!canProceed()}
              className="flex items-center gap-2 px-6 py-2 primary-gradient text-on-primary text-sm font-bold rounded-lg ambient-shadow hover:scale-[1.02] disabled:opacity-40 disabled:scale-100 transition-transform"
            >
              Next: {STEPS[step + 1].label}
              <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={saving || selectedLeadIds.length === 0}
              className="flex items-center gap-2 px-6 py-2 bg-[#006630] text-white text-sm font-bold rounded-lg ambient-shadow hover:scale-[1.02] disabled:opacity-50 disabled:scale-100 transition-transform"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <span className="material-symbols-outlined text-[16px]">rocket_launch</span>}
              {saving ? 'Creating...' : 'Create Campaign'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

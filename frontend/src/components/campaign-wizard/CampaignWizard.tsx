'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import WizardStep1Leads from './WizardStep1Leads';
import WizardStep2Sequence from './WizardStep2Sequence';
import WizardStep3Options from './WizardStep3Options';
import WizardStep4Launch from './WizardStep4Launch';
import type { FollowUpStepInput } from '../../types/campaign';
import { DEFAULT_SCHEDULE, COUNTRY_TIMEZONE, type SendingSchedule } from './scheduleConfig';

const DEFAULT_SUBJECT = '';
const DEFAULT_BODY = '';

// Pre-fill copy for discovery follow-up campaigns. Mentions the original
// support inbox we emailed and the brand we found on Trustpilot — the
// recipient already disclosed the right contact via auto-reply, so the
// follow-up acknowledges that handoff explicitly to feel less spammy.
const DISCOVERY_FOLLOWUP_SUBJECT = '{{company_name}} — quick follow-up on what I sent your support inbox';
const DISCOVERY_FOLLOWUP_BODY = `<p>Hi there,</p>
<p>I reached out to your team a little earlier and was pointed to this address as the right place to follow up.</p>
<p>I came across <strong>{{company_name}}</strong> on Trustpilot — at <strong>{{star_rating}}/5</strong> there's room to lift conversion just by tightening up how reviews are managed. We help brands like yours respond faster, surface the good ones, and rebuild rating velocity.</p>
<p>Worth a 10-minute look?</p>
<p>— OptiRate</p>`;

const STEPS = [
  { n: 1, label: 'Select Leads',  next: 'Continue to Sequence'  },
  { n: 2, label: 'Sequence',      next: 'Continue to Options'   },
  { n: 3, label: 'Options',       next: 'Continue to Launch'    },
  { n: 4, label: 'Launch',        next: 'Launch Campaign'       },
];

interface Props {
  onClose: () => void;
  onCreate: (data: {
    name: string;
    templateSubject: string;
    templateBody: string;
    includeScreenshot: boolean;
    leadIds: string[];
    manualEmails?: string[];
    followUpSteps?: FollowUpStepInput[];
    sendingSchedule?: SendingSchedule;
    campaignType?: 'outreach' | 'discovery_followup';
  }) => Promise<void>;
  /** Launched from the Redirected Leads page. Filters the lead picker to
   *  leads whose Trustpilot listing redirects to a different brand and
   *  switches the AI prompt to redirect-aware copy. */
  redirectMode?: boolean;
  /** Launched from the Prospects → Accepted tab. Pre-fills a discovery
   *  follow-up template, marks the campaign as type='discovery_followup'
   *  on submit, and the backend's addLeadsToCampaign routes sends to
   *  lead.discovered_email instead of primary_email. */
  discoveryMode?: boolean;
  /** Pre-select these leads when the wizard mounts. Used by the
   *  Redirected Leads page to hand off a chosen set straight into the
   *  recipient picker. */
  initialLeadIds?: string[];
}

export default function CampaignWizard({ onClose, onCreate, redirectMode, discoveryMode, initialLeadIds }: Props) {
  const [step, setStep]             = useState(0);
  const [saving, setSaving]         = useState(false);

  // Step 1 — Leads
  const [filterCountry, setFilterCountry]     = useState('');
  const [filterCategory, setFilterCategory]   = useState('');
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>(initialLeadIds ?? []);
  const [manualEmails, setManualEmails]       = useState<string[]>([]);
  const [maxLeads, setMaxLeads]               = useState(500);

  // Step 2 — Sequence. Discovery follow-up gets a dedicated pre-fill so the
  // user lands in the editor with a draft that already references the
  // original support handoff.
  const [subject, setSubject]               = useState(discoveryMode ? DISCOVERY_FOLLOWUP_SUBJECT : DEFAULT_SUBJECT);
  const [body, setBody]                     = useState(discoveryMode ? DISCOVERY_FOLLOWUP_BODY : DEFAULT_BODY);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [followUpSteps, setFollowUpSteps]   = useState<FollowUpStepInput[]>([]);

  // Step 3 — Options
  const [name, setName]         = useState('');
  const [schedule, setSchedule] = useState<SendingSchedule>(DEFAULT_SCHEDULE);
  const [timezoneTouched, setTimezoneTouched] = useState(false);

  // Auto-shift the schedule timezone when the user picks a country, unless
  // they've already manually overridden it. Hours / days / dailyLimit stay
  // the same — only the timezone moves.
  const handleFilterCountryChange = (code: string) => {
    setFilterCountry(code);
    if (timezoneTouched) return;
    const tz = COUNTRY_TIMEZONE[code];
    if (tz && tz !== schedule.timezone) {
      setSchedule((prev) => ({ ...prev, timezone: tz }));
    }
  };

  // Mark the timezone "touched" the moment the user changes it manually so
  // the country auto-pick stops overwriting their choice.
  const handleScheduleChange = (next: SendingSchedule) => {
    if (next.timezone !== schedule.timezone) setTimezoneTouched(true);
    setSchedule(next);
  };

  const canProceed = () => {
    if (step === 0) return selectedLeadIds.length > 0 || manualEmails.length > 0;
    if (step === 1) return subject.trim().length > 0 && body.trim().length > 0;
    if (step === 2) return name.trim().length > 0;
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
        manualEmails: manualEmails.length > 0 ? manualEmails : undefined,
        followUpSteps: followUpSteps.length > 0 ? followUpSteps : undefined,
        sendingSchedule: schedule,
        campaignType: discoveryMode ? 'discovery_followup' : undefined,
      });
      onClose();
    } catch {
      setSaving(false);
    }
  };

  const isLast = step === STEPS.length - 1;

  return (
    <div className="flex flex-col bg-[#f8f9fa]" style={{ minHeight: 'calc(100vh - 4rem)' }}>

      {/* ── Top nav ── */}
      <div className="bg-white border-b border-slate-100 px-8 py-0 flex items-center justify-between h-14 flex-shrink-0">
        <div className="flex items-center gap-8">
          <span className="text-lg font-extrabold text-[#b0004a]" style={{ fontFamily: 'Manrope, sans-serif' }}>
            Elite Outreach
          </span>
          <nav className="flex items-center gap-6">
            <button onClick={onClose} className="text-sm font-semibold text-secondary hover:text-on-surface transition-colors py-4">
              Campaigns
            </button>
            <span className="text-sm font-bold text-[#b0004a] border-b-2 border-[#b0004a] py-4">Wizard</span>
            <button
              disabled
              title="Coming soon"
              className="text-sm font-semibold text-secondary py-4 opacity-40 cursor-not-allowed"
            >
              Settings
            </button>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <button
            disabled
            title="Coming soon"
            className="p-2 rounded-full text-secondary opacity-40 cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[20px]">help_outline</span>
          </button>
          <button
            disabled
            title="Coming soon"
            className="p-2 rounded-full text-secondary opacity-40 cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[20px]">notifications</span>
          </button>
          <div className="w-8 h-8 rounded-full primary-gradient flex items-center justify-center">
            <span className="text-on-primary text-xs font-bold">A</span>
          </div>
        </div>
      </div>

      {/* ── Mode banner ── */}
      {discoveryMode && (
        <div className="bg-amber-50 border-b border-amber-200 px-8 py-2 text-xs font-bold text-amber-800 flex items-center gap-2 flex-shrink-0">
          <span className="material-symbols-outlined text-[14px]">forward_to_inbox</span>
          Discovery Follow-Up Campaign — sends to each lead's accepted discovered_email rather than primary_email.
        </div>
      )}

      {/* ── Step indicator ── */}
      <div className="bg-white border-b border-slate-100 px-8 py-4 flex items-center justify-center flex-shrink-0">
        <div className="flex items-center gap-0">
          {STEPS.map((s, i) => {
            const isDone   = i < step;
            const isActive = i === step;
            return (
              <div key={s.n} className="flex items-center">
                {i > 0 && (
                  <div className={`w-16 h-px mx-1 ${isDone ? 'bg-[#b0004a]' : 'bg-slate-200'}`} />
                )}
                <div className="flex items-center gap-2">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold transition-all ${
                    isDone    ? 'bg-[#b0004a] text-white' :
                    isActive  ? 'bg-[#b0004a] text-white ring-4 ring-[#b0004a]/20' :
                                'bg-slate-100 text-slate-400'
                  }`}>
                    {isDone
                      ? <span className="material-symbols-outlined text-[14px]">check</span>
                      : s.n
                    }
                  </div>
                  <span className={`text-sm font-bold ${isActive ? 'text-[#b0004a]' : isDone ? 'text-slate-600' : 'text-slate-400'}`}>
                    {s.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Page content ── */}
      <div className="flex-1 overflow-y-auto">
        {step === 0 && (
          <WizardStep1Leads
            filterCountry={filterCountry}
            filterCategory={filterCategory}
            selectedLeadIds={selectedLeadIds}
            manualEmails={manualEmails}
            maxLeads={maxLeads}
            redirectMode={redirectMode}
            discoveryMode={discoveryMode}
            onFilterCountryChange={handleFilterCountryChange}
            onFilterCategoryChange={setFilterCategory}
            onSelectionChange={setSelectedLeadIds}
            onManualEmailsChange={setManualEmails}
            onMaxLeadsChange={setMaxLeads}
          />
        )}
        {step === 1 && (
          <WizardStep2Sequence
            subject={subject}
            body={body}
            includeScreenshot={includeScreenshot}
            filterCountry={filterCountry}
            filterCategory={filterCategory}
            manualEmails={manualEmails}
            followUpSteps={followUpSteps}
            redirectMode={redirectMode}
            discoveryMode={discoveryMode}
            onSubjectChange={setSubject}
            onBodyChange={setBody}
            onIncludeScreenshotChange={setIncludeScreenshot}
            onFollowUpStepsChange={setFollowUpSteps}
          />
        )}
        {step === 2 && (
          <WizardStep3Options
            name={name}
            schedule={schedule}
            onNameChange={setName}
            onScheduleChange={handleScheduleChange}
          />
        )}
        {step === 3 && (
          <WizardStep4Launch
            name={name}
            subject={subject}
            body={body}
            includeScreenshot={includeScreenshot}
            filterCountry={filterCountry}
            filterCategory={filterCategory}
            recipientCount={selectedLeadIds.length + manualEmails.length}
            followUpCount={followUpSteps.length}
            schedule={schedule}
            saving={saving}
            onSubmit={handleSubmit}
          />
        )}
      </div>

      {/* ── Bottom bar ── */}
      <div className="bg-white border-t border-slate-100 px-8 py-4 flex items-center justify-between flex-shrink-0">
        <button
          onClick={() => step > 0 ? setStep(step - 1) : onClose()}
          className="flex items-center gap-2 text-sm font-bold text-secondary hover:text-on-surface transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          {step === 0 ? 'Back to Dashboard' : 'Previous Step'}
        </button>

        <button
          onClick={() => isLast ? handleSubmit() : setStep(step + 1)}
          disabled={!canProceed() || saving}
          className="flex items-center gap-2 px-8 py-3 primary-gradient text-on-primary text-sm font-bold rounded-full ambient-shadow hover:scale-[1.02] disabled:opacity-40 disabled:scale-100 transition-transform"
        >
          {saving
            ? <><Loader2 size={15} className="animate-spin" /> Creating...</>
            : <>{STEPS[step].next} <span className="material-symbols-outlined text-[16px]">arrow_forward</span></>
          }
        </button>
      </div>

    </div>
  );
}

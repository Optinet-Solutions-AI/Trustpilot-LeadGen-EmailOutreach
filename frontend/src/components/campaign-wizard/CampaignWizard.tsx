'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import WizardStep1Leads from './WizardStep1Leads';
import WizardStep2Sequence from './WizardStep2Sequence';
import WizardStep3Options from './WizardStep3Options';
import WizardStep4Launch from './WizardStep4Launch';
import type { FollowUpStepInput } from '../../types/campaign';
import { DEFAULT_SCHEDULE, type SendingSchedule } from './scheduleConfig';

const DEFAULT_SUBJECT = '';
const DEFAULT_BODY = '';

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
  }) => Promise<void>;
}

export default function CampaignWizard({ onClose, onCreate }: Props) {
  const [step, setStep]             = useState(0);
  const [saving, setSaving]         = useState(false);

  // Step 1 — Leads
  const [filterCountry, setFilterCountry]     = useState('');
  const [filterCategory, setFilterCategory]   = useState('');
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [manualEmails, setManualEmails]       = useState<string[]>([]);
  const [maxLeads, setMaxLeads]               = useState(500);

  // Step 2 — Sequence
  const [subject, setSubject]               = useState(DEFAULT_SUBJECT);
  const [body, setBody]                     = useState(DEFAULT_BODY);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [followUpSteps, setFollowUpSteps]   = useState<FollowUpStepInput[]>([]);

  // Step 3 — Options
  const [name, setName]         = useState('');
  const [schedule, setSchedule] = useState<SendingSchedule>(DEFAULT_SCHEDULE);

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
            onFilterCountryChange={setFilterCountry}
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
            followUpSteps={followUpSteps}
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
            onScheduleChange={setSchedule}
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

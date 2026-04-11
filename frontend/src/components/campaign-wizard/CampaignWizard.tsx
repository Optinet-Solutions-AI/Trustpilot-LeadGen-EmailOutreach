import { useState, useEffect } from 'react';
import WizardStepper from './WizardStepper';
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

export default function CampaignWizard({ onClose, onCreate }: Props) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [schedule, setSchedule] = useState<SendingSchedule>(DEFAULT_SCHEDULE);
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [followUpSteps, setFollowUpSteps] = useState<FollowUpStepInput[]>([]);
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface-container-lowest rounded-2xl ambient-shadow w-full max-w-3xl max-h-[90vh] flex flex-col border border-slate-100">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl primary-gradient flex items-center justify-center">
              <span className="material-symbols-outlined text-on-primary text-[18px]">magic_button</span>
            </div>
            <div>
              <h2
                className="text-lg font-extrabold text-on-surface"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                New Campaign
              </h2>
              <p className="text-xs text-secondary">Step {step + 1} of 5</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-secondary hover:text-on-surface rounded-lg hover:bg-surface-container transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Stepper */}
        <WizardStepper currentStep={step} completedSteps={completedSteps} />

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
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

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 bg-surface-container rounded-b-2xl">
          <button
            onClick={() => step > 0 ? setStep(step - 1) : onClose()}
            className="flex items-center gap-2 text-sm font-bold text-secondary hover:text-on-surface transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>

          {step < 4 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!canProceed()}
              className="flex items-center gap-2 primary-gradient text-on-primary px-5 py-2.5 rounded-lg text-sm font-bold ambient-shadow hover:scale-[1.02] disabled:opacity-40 disabled:scale-100 transition-transform"
            >
              Next
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
          ) : (
            <div />
          )}
        </div>
      </div>
    </div>
  );
}

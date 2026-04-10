import { useState, useEffect } from 'react';
import { X, ArrowLeft, ArrowRight } from 'lucide-react';
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

  // Wizard state
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
  completedSteps.add(2); // follow-ups are always optional / valid
  if (selectedLeadIds.length > 0) completedSteps.add(3);

  const canProceed = () => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return subject.trim().length > 0 && body.trim().length > 0;
    if (step === 2) return true; // follow-ups are optional
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

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-bold">New Campaign</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={20} />
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
            <StepFollowUps
              steps={followUpSteps}
              onChange={setFollowUpSteps}
            />
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

        {/* Footer navigation */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50 rounded-b-2xl">
          <button
            onClick={() => step > 0 ? setStep(step - 1) : onClose()}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft size={14} />
            {step === 0 ? 'Cancel' : 'Back'}
          </button>

          {step < 4 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!canProceed()}
              className="flex items-center gap-1.5 bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              Next <ArrowRight size={14} />
            </button>
          ) : (
            <div /> // Submit button is in StepReview
          )}
        </div>
      </div>
    </div>
  );
}

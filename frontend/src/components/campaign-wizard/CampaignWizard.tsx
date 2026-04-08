import { useState, useEffect } from 'react';
import { X, ArrowLeft, ArrowRight } from 'lucide-react';
import WizardStepper from './WizardStepper';
import StepSetup from './StepSetup';
import StepTemplate from './StepTemplate';
import StepRecipients from './StepRecipients';
import StepReview from './StepReview';

const DEFAULT_SUBJECT = 'Your Trustpilot rating needs attention, {{company_name}}';

const DEFAULT_BODY = `<p>Hi,</p>

<p>We recently noticed your brand's Trustpilot score isn't where it should be, with a relatively low overall rating (see details below). Our team can help you improve your Trustpilot score by boosting positive visibility, achieving a green rating, and enhancing your brand's credibility and trustworthy online image.</p>

<p><strong>{{company_name}}</strong><br>
Trustpilot Rating: {{star_rating}} ★</p>

<p>Would you be open to a quick chat to see how we can clean up your Trustpilot presence and strengthen your online reputation?</p>

<p>Best regards,<br>
OptiRate</p>
<p>www.optiratesolutions.com</p>`;

interface Props {
  onClose: () => void;
  onCreate: (data: {
    name: string;
    templateSubject: string;
    templateBody: string;
    includeScreenshot: boolean;
    filterCountry?: string;
    filterCategory?: string;
  }) => Promise<void>;
  previewRecipients: (filters: { country?: string; category?: string }) => Promise<{
    count: number;
    sample: Array<{ id: string; company_name: string; primary_email: string; star_rating: number }>;
  }>;
}

export default function CampaignWizard({ onClose, onCreate, previewRecipients }: Props) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Wizard state
  const [name, setName] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [recipientCount, setRecipientCount] = useState(0);

  // Fetch recipient count when reaching step 2 (recipients)
  useEffect(() => {
    if (step === 2) {
      previewRecipients({
        country: filterCountry || undefined,
        category: filterCategory || undefined,
      }).then((r) => setRecipientCount(r.count)).catch(() => setRecipientCount(0));
    }
  }, [step, filterCountry, filterCategory, previewRecipients]);

  const completedSteps = new Set<number>();
  if (name.trim()) completedSteps.add(0);
  if (subject.trim() && body.trim()) completedSteps.add(1);
  if (step > 2) completedSteps.add(2);

  const canProceed = () => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return subject.trim().length > 0 && body.trim().length > 0;
    if (step === 2) return true; // Can proceed even with 0 leads (review will show warning)
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
        filterCountry: filterCountry || undefined,
        filterCategory: filterCategory || undefined,
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
              onChange={(patch) => {
                if (patch.name !== undefined) setName(patch.name);
                if (patch.filterCountry !== undefined) setFilterCountry(patch.filterCountry);
                if (patch.filterCategory !== undefined) setFilterCategory(patch.filterCategory);
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
            <StepRecipients
              filterCountry={filterCountry}
              filterCategory={filterCategory}
              previewRecipients={previewRecipients}
            />
          )}
          {step === 3 && (
            <StepReview
              name={name}
              subject={subject}
              body={body}
              includeScreenshot={includeScreenshot}
              filterCountry={filterCountry}
              filterCategory={filterCategory}
              recipientCount={recipientCount}
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

          {step < 3 ? (
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

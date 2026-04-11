import { useState } from 'react';
import type { FollowUpStepInput } from '../../types/campaign';

interface Props {
  steps: FollowUpStepInput[];
  onChange: (steps: FollowUpStepInput[]) => void;
}

const DEFAULT_FOLLOW_UP_BODY = `<p>{Hi|Hello|Hey} again,</p>

<p>{I wanted to follow up on|Just circling back on|Quick follow-up regarding} my previous email about your Trustpilot {profile|rating|presence}. {I understand you're busy|I know things get hectic}, but {I'd love to help|we can really help} {{company_name}} {improve your online reputation|boost your review score|strengthen your Trustpilot profile}.</p>

<p>{Would a quick 10-minute call work|Could we schedule a brief chat|Is there a good time to connect}?</p>

<p>{Best regards|Kind regards|Best},<br>
OptiRate</p>`;

const DELAY_OPTIONS = [
  { value: 2, label: '2 days' },
  { value: 3, label: '3 days' },
  { value: 5, label: '5 days' },
  { value: 7, label: '7 days' },
  { value: 10, label: '10 days' },
  { value: 14, label: '14 days' },
];

export default function StepFollowUps({ steps, onChange }: Props) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(steps.length > 0 ? 0 : null);

  const addStep = () => {
    const newStep: FollowUpStepInput = {
      delayDays: steps.length === 0 ? 3 : 5,
      subject: 'Re: {Your Trustpilot rating needs attention|A quick note about your online reputation}, {{company_name}}',
      body: DEFAULT_FOLLOW_UP_BODY,
    };
    const updated = [...steps, newStep];
    onChange(updated);
    setExpandedIdx(updated.length - 1);
  };

  const removeStep = (idx: number) => {
    const updated = steps.filter((_, i) => i !== idx);
    onChange(updated);
    if (expandedIdx === idx) setExpandedIdx(null);
    else if (expandedIdx !== null && expandedIdx > idx) setExpandedIdx(expandedIdx - 1);
  };

  const updateStep = (idx: number, patch: Partial<FollowUpStepInput>) => {
    onChange(steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  return (
    <div className="space-y-5">

      {/* Header */}
      <div>
        <h3
          className="text-xl font-extrabold text-on-surface"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Follow-up Sequence
        </h3>
        <p className="text-sm text-secondary mt-0.5">
          Add follow-up emails sent automatically to leads who haven&apos;t replied.
        </p>
      </div>

      {/* Timeline */}
      <div className="space-y-3">

        {/* Step 1 — initial email (fixed) */}
        <div className="flex items-center gap-3 bg-surface-container rounded-xl px-4 py-3">
          <div className="w-8 h-8 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-on-primary text-[15px]">mail</span>
          </div>
          <div>
            <p className="text-sm font-bold text-on-surface">Step 1 — Initial Email</p>
            <p className="text-xs text-secondary">Configured in the Template step</p>
          </div>
        </div>

        {steps.length === 0 && (
          <div className="ml-4 pl-4 border-l-2 border-dashed border-slate-200 py-3">
            <p className="text-sm text-secondary">No follow-ups configured — campaign sends a single email per lead.</p>
          </div>
        )}

        {steps.map((step, idx) => (
          <div key={idx} className="ml-4 pl-4 border-l-2 border-[#b0004a]/20">

            {/* Step header */}
            <div
              className="flex items-center justify-between bg-surface-container-lowest rounded-xl px-4 py-3 cursor-pointer hover:bg-surface-container transition-colors border border-slate-50 ambient-shadow"
              onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
            >
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-[#ffd9de] flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-[#b0004a] text-[13px]">schedule_send</span>
                </div>
                <div>
                  <p className="text-sm font-bold text-on-surface">
                    Step {idx + 2} — Follow-up after {step.delayDays} day{step.delayDays !== 1 ? 's' : ''}
                  </p>
                  <p className="text-xs text-secondary truncate max-w-xs">{step.subject.slice(0, 60)}{step.subject.length > 60 ? '…' : ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={(e) => { e.stopPropagation(); removeStep(idx); }}
                  className="p-1.5 text-secondary hover:text-error rounded-lg hover:bg-red-50 transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px]">delete</span>
                </button>
                <span className="material-symbols-outlined text-secondary text-[18px]">
                  {expandedIdx === idx ? 'expand_less' : 'expand_more'}
                </span>
              </div>
            </div>

            {/* Expanded editor */}
            {expandedIdx === idx && (
              <div className="mt-2 bg-surface-container rounded-xl p-4 space-y-4 border border-slate-100">

                {/* Delay */}
                <div>
                  <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">
                    Send after (days since previous step)
                  </label>
                  <select
                    value={step.delayDays}
                    onChange={(e) => updateStep(idx, { delayDays: Number(e.target.value) })}
                    className="w-full bg-surface-container-lowest rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                  >
                    {DELAY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {/* Subject */}
                <div>
                  <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">
                    Subject <span className="normal-case font-normal">(supports spintax & tokens)</span>
                  </label>
                  <input
                    type="text"
                    value={step.subject}
                    onChange={(e) => updateStep(idx, { subject: e.target.value })}
                    placeholder="Re: Your Trustpilot rating, {{company_name}}"
                    className="w-full bg-surface-container-lowest rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                  />
                </div>

                {/* Body */}
                <div>
                  <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">
                    Email Body <span className="normal-case font-normal">(HTML, spintax & tokens)</span>
                  </label>
                  <textarea
                    value={step.body}
                    onChange={(e) => updateStep(idx, { body: e.target.value })}
                    rows={8}
                    className="w-full bg-surface-container-lowest rounded-lg px-3 py-2.5 text-xs font-mono border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none resize-none"
                  />
                </div>

                <p className="text-xs text-secondary">
                  Tokens: <code className="bg-surface-container-highest px-1 rounded">{'{{company_name}}'}</code>{' '}
                  <code className="bg-surface-container-highest px-1 rounded">{'{{website_url}}'}</code>{' '}
                  <code className="bg-surface-container-highest px-1 rounded">{'{{star_rating}}'}</code>{' '}
                  <code className="bg-surface-container-highest px-1 rounded">{'{{category}}'}</code>{' '}
                  <code className="bg-surface-container-highest px-1 rounded">{'{{country}}'}</code>
                </p>
              </div>
            )}
          </div>
        ))}

        {/* Add step button */}
        {steps.length < 5 && (
          <button
            onClick={addStep}
            className="ml-4 flex items-center gap-2 text-sm font-bold text-[#b0004a] hover:text-[#7a0033] transition-colors py-2"
          >
            <span className="w-7 h-7 rounded-full border-2 border-dashed border-[#b0004a]/40 flex items-center justify-center">
              <span className="material-symbols-outlined text-[16px]">add</span>
            </span>
            Add Follow-up Step
          </button>
        )}
      </div>

      {steps.length > 0 && (
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-xs text-blue-700">
          <span className="font-bold">How it works:</span> After the initial email, leads who haven&apos;t replied
          receive follow-ups at the configured intervals. Leads who reply are automatically removed from the sequence.
        </div>
      )}
    </div>
  );
}

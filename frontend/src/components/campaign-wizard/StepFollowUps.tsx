import { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp, Clock, Mail } from 'lucide-react';
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
    const updated = steps.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange(updated);
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900">Follow-up Sequence</h3>
        <p className="text-sm text-gray-500 mt-1">
          Add follow-up emails that are automatically sent to leads who haven't replied.
          Each follow-up waits the specified number of days after the previous step.
        </p>
      </div>

      {/* Visual timeline of steps */}
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-3">
          <Mail size={12} />
          <span className="font-medium text-gray-700">Step 1: Initial Email</span>
          <span className="text-gray-400">(configured in Template step)</span>
        </div>

        {steps.length === 0 && (
          <p className="text-sm text-gray-400 ml-5 border-l-2 border-gray-200 pl-4 py-2">
            No follow-ups configured. Campaign will send a single email per lead.
          </p>
        )}

        {steps.map((step, idx) => (
          <div key={idx} className="ml-5 border-l-2 border-blue-200 pl-4 mt-2">
            {/* Step header — clickable to expand/collapse */}
            <div
              className="flex items-center justify-between cursor-pointer hover:bg-white rounded-lg p-2 -ml-2 transition-colors"
              onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-blue-400 -ml-[21px]" />
                <Clock size={12} className="text-blue-400" />
                <span className="text-xs font-medium text-gray-700">
                  Step {idx + 2}: Follow-up after {step.delayDays} day{step.delayDays !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={(e) => { e.stopPropagation(); removeStep(idx); }}
                  className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
                {expandedIdx === idx ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
              </div>
            </div>

            {/* Expanded editor */}
            {expandedIdx === idx && (
              <div className="mt-2 space-y-3 bg-white rounded-xl border border-gray-200 p-4">
                {/* Delay selector */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Send after (days since previous step)
                  </label>
                  <select
                    value={step.delayDays}
                    onChange={(e) => updateStep(idx, { delayDays: Number(e.target.value) })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    {DELAY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {/* Subject */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Subject <span className="text-gray-400 font-normal">(supports spintax & tokens)</span>
                  </label>
                  <input
                    type="text"
                    value={step.subject}
                    onChange={(e) => updateStep(idx, { subject: e.target.value })}
                    placeholder="Re: Your Trustpilot rating, {{company_name}}"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                {/* Body */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Email Body <span className="text-gray-400 font-normal">(HTML, spintax & tokens)</span>
                  </label>
                  <textarea
                    value={step.body}
                    onChange={(e) => updateStep(idx, { body: e.target.value })}
                    rows={8}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                {/* Token reference */}
                <div className="text-xs text-gray-400">
                  Tokens: {'{{company_name}}'} {'{{website_url}}'} {'{{star_rating}}'} {'{{category}}'} {'{{country}}'}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Add follow-up button */}
        {steps.length < 5 && (
          <button
            onClick={addStep}
            className="mt-3 ml-5 inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
          >
            <Plus size={14} />
            Add Follow-up Step
          </button>
        )}
      </div>

      {steps.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-700">
          <strong>How it works:</strong> After the initial email, leads who haven't replied will
          automatically receive follow-up emails at the configured intervals.
          {' '}Leads who reply are automatically removed from the sequence.
        </div>
      )}
    </div>
  );
}

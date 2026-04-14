'use client';

import { useState } from 'react';
import type { FollowUpStepInput } from '../../types/campaign';
import { generateEmailTemplate, domainToCompanyName } from '../../lib/gemini';

interface Props {
  subject: string;
  body: string;
  includeScreenshot: boolean;
  filterCountry: string;
  filterCategory: string;
  manualEmails?: string[];
  followUpSteps: FollowUpStepInput[];
  onSubjectChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onIncludeScreenshotChange: (v: boolean) => void;
  onFollowUpStepsChange: (steps: FollowUpStepInput[]) => void;
}

const TOKENS = [
  { label: '{{company_name}}', desc: 'Company name' },
  { label: '{{star_rating}}',  desc: 'Star rating' },
  { label: '{{country}}',      desc: 'Country' },
];

const SPINTAX_EXAMPLES = [
  '{Hi|Hello|Hey}',
  '{Best regards|Kind regards|Best}',
  '{We noticed|We saw|Our team found}',
];

export default function WizardStep2Sequence({
  subject, body, includeScreenshot, filterCountry, filterCategory, manualEmails, followUpSteps,
  onSubjectChange, onBodyChange, onIncludeScreenshotChange, onFollowUpStepsChange,
}: Props) {
  const [activeStep, setActiveStep] = useState<'intro' | number>('intro');
  const [previewMode, setPreviewMode] = useState<'raw' | 'preview'>('raw');
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState('');

  // Infer preview company name from first manual email domain
  const firstEmailDomain = manualEmails?.[0]?.includes('@') ? manualEmails[0].split('@')[1] : undefined;
  const previewCompanyName = firstEmailDomain ? domainToCompanyName(firstEmailDomain) : 'Acme Corp';

  const handleGenerateWithAI = async () => {
    setGenerating(true);
    setAiError('');
    try {
      const result = await generateEmailTemplate({
        country: filterCountry || undefined,
        category: filterCategory || undefined,
        emailDomain: firstEmailDomain,
        manualMode: !!(manualEmails && manualEmails.length > 0),
      });
      onSubjectChange(result.subject);
      onBodyChange(result.body);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI generation failed.');
    } finally {
      setGenerating(false);
    }
  };

  const addFollowUp = () => {
    const newStep: FollowUpStepInput = {
      delayDays: followUpSteps.length === 0 ? 3 : followUpSteps[followUpSteps.length - 1].delayDays + 3,
      subject: `Follow-up: {Checking in|Quick follow-up|Just following up}`,
      body: `<p>{Hi|Hello|Hey},</p><p>I just wanted to {follow up|circle back} on my previous email regarding your Trustpilot rating.</p><p>{Best regards|Kind regards},<br>OptiRate<br>www.optiratesolutions.com</p>`,
    };
    onFollowUpStepsChange([...followUpSteps, newStep]);
    setActiveStep(followUpSteps.length);
  };

  const removeFollowUp = (idx: number) => {
    const updated = followUpSteps.filter((_, i) => i !== idx);
    onFollowUpStepsChange(updated);
    setActiveStep('intro');
  };

  const updateFollowUp = (idx: number, field: keyof FollowUpStepInput, value: string | number) => {
    const updated = followUpSteps.map((s, i) => i === idx ? { ...s, [field]: value } : s);
    onFollowUpStepsChange(updated);
  };

  const insertToken = (token: string, field: 'subject' | 'body') => {
    if (field === 'subject') onSubjectChange(subject + token);
    else onBodyChange(body + token);
  };

  const activeSubject = activeStep === 'intro' ? subject : followUpSteps[activeStep as number]?.subject ?? '';
  const activeBody    = activeStep === 'intro' ? body    : followUpSteps[activeStep as number]?.body ?? '';
  const setActiveSubject = (v: string) => {
    if (activeStep === 'intro') onSubjectChange(v);
    else updateFollowUp(activeStep as number, 'subject', v);
  };
  const setActiveBody = (v: string) => {
    if (activeStep === 'intro') onBodyChange(v);
    else updateFollowUp(activeStep as number, 'body', v);
  };

  // Apply preview tokens so the panel shows a realistic sample
  const applyPreviewTokens = (text: string) =>
    text
      .replace(/\{\{company_name\}\}/g, previewCompanyName)
      .replace(/\{\{star_rating\}\}/g, '2.5')
      .replace(/\{\{review_count\}\}/g, '47')
      .replace(/\{\{country\}\}/g, filterCountry || 'US')
      .replace(/\{\{website\}\}/g, firstEmailDomain || 'example.com');

  const bodyPreview = applyPreviewTokens(body).replace(/<[^>]+>/g, '').slice(0, 400);
  const subjectPreview = applyPreviewTokens(activeSubject);

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">

      {/* Headline */}
      <div className="text-center mb-10">
        <h1 className="text-3xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Design Your Email Sequence
        </h1>
        <p className="text-secondary text-sm">
          Write your initial outreach email and optionally add follow-up steps
          that send automatically when a lead doesn&apos;t reply.
        </p>
      </div>

      <div className="grid grid-cols-[1fr_340px] gap-6">

        {/* ── Left: sequence builder ── */}
        <div className="space-y-4">

          {/* Step timeline */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {/* Intro email step */}
            <button
              onClick={() => setActiveStep('intro')}
              className={`flex-shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${
                activeStep === 'intro'
                  ? 'primary-gradient text-on-primary ambient-shadow'
                  : 'bg-white border border-slate-100 text-secondary hover:bg-surface-container'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">mail</span>
              Step 1 · Introduction
            </button>

            {/* Follow-up steps */}
            {followUpSteps.map((step, idx) => (
              <button
                key={idx}
                onClick={() => setActiveStep(idx)}
                className={`flex-shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${
                  activeStep === idx
                    ? 'primary-gradient text-on-primary ambient-shadow'
                    : 'bg-white border border-slate-100 text-secondary hover:bg-surface-container'
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">schedule_send</span>
                Step {idx + 2} · +{step.delayDays}d
              </button>
            ))}

            {/* Add follow-up */}
            <button
              onClick={addFollowUp}
              className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-bold text-[#b0004a] bg-[#ffd9de]/40 hover:bg-[#ffd9de]/70 transition-colors border border-[#b0004a]/20"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Follow-up
            </button>
          </div>

          {/* Active step editor */}
          <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
            {/* Step header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-surface-container">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full primary-gradient flex items-center justify-center">
                  <span className="material-symbols-outlined text-on-primary text-[14px]">
                    {activeStep === 'intro' ? 'mail' : 'schedule_send'}
                  </span>
                </div>
                <div>
                  <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                    {activeStep === 'intro' ? 'Introduction Email' : `Follow-up #${(activeStep as number) + 1}`}
                  </p>
                  <p className="text-xs text-secondary">
                    {activeStep === 'intro'
                      ? 'First email sent to each lead'
                      : `Sent ${followUpSteps[activeStep as number]?.delayDays ?? 0} days after previous step if no reply`}
                  </p>
                </div>
              </div>
              {activeStep === 'intro' ? (
                <button
                  type="button"
                  onClick={handleGenerateWithAI}
                  disabled={generating}
                  className="flex items-center gap-1.5 bg-[#ffd9de] text-[#b0004a] px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-[#b0004a] hover:text-white transition-colors disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
                  {generating ? 'Generating...' : 'Generate with AI'}
                </button>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-bold text-secondary">Delay (days)</label>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={followUpSteps[activeStep as number]?.delayDays ?? 3}
                      onChange={(e) => updateFollowUp(activeStep as number, 'delayDays', Number(e.target.value))}
                      className="w-16 bg-white border border-slate-200 rounded-lg px-2 py-1 text-sm text-center focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                    />
                  </div>
                  <button
                    onClick={() => removeFollowUp(activeStep as number)}
                    className="p-1.5 rounded-lg text-error hover:bg-error/10 transition-colors"
                    title="Remove this step"
                  >
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                </div>
              )}
            </div>

            <div className="p-6 space-y-4">
              {/* AI error */}
              {aiError && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">
                  <span className="material-symbols-outlined text-[14px] flex-shrink-0 mt-0.5">error</span>
                  {aiError}
                </div>
              )}
              {/* Subject line */}
              <div>
                <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
                  Subject Line
                </label>
                <input
                  type="text"
                  value={activeSubject}
                  onChange={(e) => setActiveSubject(e.target.value)}
                  placeholder="e.g. A quick note about your Trustpilot rating, {{company_name}}"
                  className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                />
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {TOKENS.map((t) => (
                    <button
                      key={t.label}
                      onClick={() => insertToken(t.label, 'subject')}
                      title={t.desc}
                      className="text-[10px] font-bold bg-[#ffd9de]/50 text-[#b0004a] px-2.5 py-1 rounded-full hover:bg-[#ffd9de] transition-colors"
                    >
                      {t.label}
                    </button>
                  ))}
                  <span className="text-[10px] text-secondary ml-1">Click to insert token</span>
                </div>
              </div>

              {/* Body */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider">
                    Email Body (HTML)
                  </label>
                  <div className="flex items-center gap-1 bg-surface-container rounded-lg p-0.5">
                    <button
                      onClick={() => setPreviewMode('raw')}
                      className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${previewMode === 'raw' ? 'bg-white text-on-surface ambient-shadow' : 'text-secondary'}`}
                    >
                      HTML
                    </button>
                    <button
                      onClick={() => setPreviewMode('preview')}
                      className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${previewMode === 'preview' ? 'bg-white text-on-surface ambient-shadow' : 'text-secondary'}`}
                    >
                      Preview
                    </button>
                  </div>
                </div>

                {previewMode === 'raw' ? (
                  <textarea
                    value={activeBody}
                    onChange={(e) => setActiveBody(e.target.value)}
                    rows={10}
                    placeholder="<p>Your email body here...</p>"
                    className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm font-mono border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none resize-none"
                  />
                ) : (
                  <div
                    className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm min-h-[248px] prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: activeBody || '<p class="text-slate-400">Nothing to preview yet.</p>' }}
                  />
                )}

                {/* Token & spintax helpers */}
                <div className="flex items-start gap-4 mt-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {TOKENS.map((t) => (
                      <button
                        key={t.label}
                        onClick={() => insertToken(t.label, 'body')}
                        title={t.desc}
                        className="text-[10px] font-bold bg-[#ffd9de]/50 text-[#b0004a] px-2.5 py-1 rounded-full hover:bg-[#ffd9de] transition-colors"
                      >
                        {t.label}
                      </button>
                    ))}
                    <span className="text-[10px] text-secondary">Tokens</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {SPINTAX_EXAMPLES.map((s) => (
                      <button
                        key={s}
                        onClick={() => insertToken(s, 'body')}
                        className="text-[10px] font-bold bg-surface-container-high text-secondary px-2.5 py-1 rounded-full hover:bg-surface-container-highest transition-colors"
                      >
                        {s.slice(0, 18)}…
                      </button>
                    ))}
                    <span className="text-[10px] text-secondary">Spintax</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Screenshot toggle */}
          {activeStep === 'intro' && (
            <div
              onClick={() => onIncludeScreenshotChange(!includeScreenshot)}
              className={`flex items-center gap-4 p-4 rounded-2xl border-2 cursor-pointer transition-all ${
                includeScreenshot ? 'border-[#b0004a] bg-[#ffd9de]/20' : 'border-slate-100 bg-white hover:border-slate-200'
              }`}
            >
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${includeScreenshot ? 'primary-gradient' : 'bg-surface-container'}`}>
                <span className={`material-symbols-outlined text-[20px] ${includeScreenshot ? 'text-on-primary' : 'text-secondary'}`}>
                  screenshot_monitor
                </span>
              </div>
              <div className="flex-1">
                <p className="text-sm font-bold text-on-surface">Attach Trustpilot Screenshot</p>
                <p className="text-xs text-secondary mt-0.5">
                  Automatically embed a screenshot of each company&apos;s Trustpilot page — makes the email highly personalized.
                </p>
              </div>
              <div className={`w-11 h-6 rounded-full transition-all relative ${includeScreenshot ? 'bg-[#b0004a]' : 'bg-slate-200'}`}>
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${includeScreenshot ? 'left-5' : 'left-0.5'}`} />
              </div>
            </div>
          )}

        </div>

        {/* ── Right: panels ── */}
        <div className="space-y-4">

          {/* Message Preview — Actual Sent Message style */}
          <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Message Preview
              </p>
              <span className="text-[10px] font-bold text-secondary bg-surface-container px-2.5 py-1 rounded-full uppercase tracking-wider">
                Sample Data
              </span>
            </div>

            {/* Lead avatar + info */}
            <div className="px-4 pt-4 pb-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full primary-gradient flex items-center justify-center flex-shrink-0 text-on-primary text-sm font-extrabold">
                {previewCompanyName.charAt(0)}
              </div>
              <div>
                <p className="text-sm font-bold text-on-surface">{previewCompanyName}</p>
                <p className="text-xs text-secondary">{firstEmailDomain ? `contact@${firstEmailDomain}` : 'contact@example.com'}</p>
              </div>
            </div>

            {/* Subject */}
            <div className="px-4 pb-2">
              <p className="text-sm font-bold text-on-surface leading-snug">
                {subjectPreview || <span className="text-slate-300 font-normal text-sm">No subject yet</span>}
              </p>
            </div>

            {/* Body */}
            <div className="px-4 pb-4 max-h-[180px] overflow-y-auto">
              <p className="text-xs text-secondary leading-relaxed">
                {bodyPreview || <span className="text-slate-300">No body yet</span>}
              </p>
            </div>

            {/* Metadata */}
            <div className="border-t border-slate-100 px-4 py-3">
              <p className="text-[10px] font-extrabold text-secondary uppercase tracking-wider mb-2">Metadata</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                <div>
                  <p className="text-[10px] text-secondary">Sequence Steps</p>
                  <p className="text-xs font-semibold text-on-surface">{followUpSteps.length + 1} steps</p>
                </div>
                <div>
                  <p className="text-[10px] text-secondary">Spintax Groups</p>
                  <p className="text-xs font-semibold text-on-surface">
                    {(activeBody.match(/\{[^{}|]+\|[^{}]+\}/g) || []).length} groups
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-secondary">Active Step</p>
                  <p className="text-xs font-semibold text-on-surface">
                    {activeStep === 'intro' ? 'Introduction' : `Follow-up #${(activeStep as number) + 1}`}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-secondary">Status</p>
                  <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    activeSubject && activeBody
                      ? 'text-[#006630] bg-[#e6f4ec]'
                      : 'text-amber-700 bg-amber-50'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${activeSubject && activeBody ? 'bg-[#006630]' : 'bg-amber-400'}`} />
                    {activeSubject && activeBody ? 'Syntax Passed' : 'Incomplete'}
                  </span>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="border-t border-slate-100 px-4 py-3 flex gap-2">
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(`Subject: ${activeSubject}\n\n${activeBody.replace(/<[^>]+>/g, '')}`)}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold text-secondary border border-slate-200 rounded-lg py-2 hover:bg-surface-container transition-colors"
              >
                <span className="material-symbols-outlined text-[13px]">content_copy</span>
                Copy Message
              </button>
              {(activeBody.match(/\{[^{}|]+\|[^{}]+\}/g) || []).length > 0 && (
                <button
                  type="button"
                  onClick={() => onBodyChange(activeBody + ' ')}
                  className="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold text-[#b0004a] bg-[#ffd9de]/40 border border-[#b0004a]/20 rounded-lg py-2 hover:bg-[#ffd9de]/70 transition-colors"
                >
                  <span className="material-symbols-outlined text-[13px]">shuffle</span>
                  Randomize
                </button>
              )}
            </div>
          </div>

          {/* Optimization Suggestion */}
          {activeSubject && activeBody && (activeBody.match(/\{[^{}|]+\|[^{}]+\}/g) || []).length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
              <div className="flex items-start gap-3 p-4">
                <div className="w-7 h-7 rounded-xl bg-[#e6f4ec] flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-[14px] text-[#006630]">tips_and_updates</span>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-extrabold text-on-surface mb-1">Optimization Suggestion</p>
                  <p className="text-[11px] text-secondary leading-relaxed">
                    No spintax detected. Adding variations like <code className="bg-surface-container px-1 rounded">{'{Hi|Hello|Hey}'}</code> reduces spam detection and improves open rates.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (!activeSubject.includes('{')) {
                        setActiveSubject(`{Scale|Improve|Strengthen} your reputation, {{company_name}}`);
                      }
                    }}
                    className="mt-2 text-[10px] font-extrabold text-[#006630] uppercase tracking-wider hover:underline"
                  >
                    Apply to Sequence →
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Sequence summary */}
          <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 bg-surface-container">
              <span className="material-symbols-outlined text-[16px] text-[#b0004a]">account_tree</span>
              <p className="text-xs font-extrabold text-on-surface uppercase tracking-wider">Sequence Summary</p>
            </div>
            <div className="p-4 space-y-2">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
                  <span className="text-on-primary text-[10px] font-extrabold">1</span>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-bold text-on-surface">Introduction Email</p>
                  <p className="text-[10px] text-secondary">Sent on campaign launch</p>
                </div>
                <span className={`w-2 h-2 rounded-full ${subject && body ? 'bg-[#006630]' : 'bg-slate-200'}`} />
              </div>

              {followUpSteps.map((step, idx) => (
                <div key={idx} className="flex items-center gap-3">
                  <div className="w-px h-4 bg-slate-100 ml-3" />
                  <div className="w-7 h-7 rounded-full bg-surface-container-high flex items-center justify-center flex-shrink-0">
                    <span className="text-secondary text-[10px] font-extrabold">{idx + 2}</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-bold text-on-surface">Follow-up #{idx + 1}</p>
                    <p className="text-[10px] text-secondary">+{step.delayDays} days if no reply</p>
                  </div>
                  <span className={`w-2 h-2 rounded-full ${step.subject && step.body ? 'bg-[#006630]' : 'bg-amber-400'}`} />
                </div>
              ))}

              {followUpSteps.length === 0 && (
                <p className="text-[11px] text-secondary text-center py-2">
                  No follow-ups added yet
                </p>
              )}
            </div>
          </div>

          {/* Spintax guide */}
          <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 bg-surface-container">
              <span className="material-symbols-outlined text-[16px] text-[#b0004a]">auto_fix_high</span>
              <p className="text-xs font-extrabold text-on-surface uppercase tracking-wider">Spintax Guide</p>
            </div>
            <div className="p-4 space-y-2">
              <p className="text-[11px] text-secondary leading-relaxed">
                Use <code className="bg-surface-container px-1 rounded text-[10px]">&#123;option1|option2|option3&#125;</code> to rotate words for each send, reducing spam detection.
              </p>
              {SPINTAX_EXAMPLES.map((ex) => (
                <div key={ex} className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-[12px] text-[#b0004a] mt-0.5 flex-shrink-0">arrow_right</span>
                  <code className="text-[10px] bg-surface-container px-2 py-0.5 rounded font-mono text-secondary break-all">{ex}</code>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

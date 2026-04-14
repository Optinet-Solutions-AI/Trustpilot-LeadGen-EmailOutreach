import { useState } from 'react';
import { generateEmailTemplate } from '../../lib/gemini';

const TOKENS = ['{{company_name}}', '{{website_url}}', '{{star_rating}}', '{{category}}', '{{country}}'];

const SPINTAX_EXAMPLES = [
  { label: 'Greeting',  snippet: '{Hi|Hello|Hey}' },
  { label: 'Opening',   snippet: '{We noticed|I came across|Our team spotted}' },
  { label: 'CTA',       snippet: '{Would you be open to|Could we schedule|How about}' },
  { label: 'Closing',   snippet: '{Best regards|Kind regards|Best}' },
];

function resolveSpintaxPreview(text: string): string {
  let result = text;
  let max = 50;
  while (max-- > 0) {
    const match = result.match(/\{([^{}]+)\}/);
    if (!match) break;
    const options = match[1].split('|');
    result = result.replace(match[0], options[Math.floor(Math.random() * options.length)]);
  }
  return result;
}

interface Props {
  subject: string;
  body: string;
  includeScreenshot: boolean;
  filterCountry: string;
  filterCategory: string;
  onChange: (patch: { subject?: string; body?: string; includeScreenshot?: boolean }) => void;
}

export default function StepTemplate({ subject, body, includeScreenshot, filterCountry, filterCategory, onChange }: Props) {
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState('');
  const [showSpintaxGuide, setShowSpintaxGuide] = useState(false);
  const [previewSeed, setPreviewSeed] = useState(0);

  const handleGenerateWithAI = async () => {
    setGenerating(true);
    setAiError('');
    try {
      const result = await generateEmailTemplate({
        country: filterCountry || undefined,
        category: filterCategory || undefined,
      });
      onChange({ subject: result.subject, body: result.body });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI generation failed.');
    } finally {
      setGenerating(false);
    }
  };

  const insertToken = (token: string, field: 'subject' | 'body') => {
    if (field === 'subject') onChange({ subject: subject + token });
    else onChange({ body: body + token });
  };

  const insertSpintax = (snippet: string, field: 'subject' | 'body') => {
    if (field === 'subject') onChange({ subject: subject + snippet });
    else onChange({ body: body + snippet });
  };

  const sampleData: Record<string, string> = {
    company_name: 'Acme Corp', website_url: 'acme.com',
    star_rating: '2.5', category: 'casino', country: 'DE',
  };
  const applyTokens = (text: string) =>
    text.replace(/\{\{(\w+)\}\}/g, (_, key) => sampleData[key] ?? `{{${key}}}`);

  const resolvedBody    = resolveSpintaxPreview(applyTokens(body)    + (previewSeed < 0 ? '' : ''));
  const resolvedSubject = resolveSpintaxPreview(applyTokens(subject) + (previewSeed < 0 ? '' : ''));
  const preview         = resolvedBody.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const spintaxCount    = (body.match(/\{[^{}]+\}/g) || []).length + (subject.match(/\{[^{}]+\}/g) || []).length;

  return (
    <div className="space-y-5">

      {/* Header */}
      <div>
        <h3
          className="text-xl font-extrabold text-on-surface"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Email Template
        </h3>
        <p className="text-sm text-secondary mt-0.5">
          Compose your outreach email. Use tokens to personalize and spintax for unique variations.
        </p>
      </div>

      {/* Spintax guide */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setShowSpintaxGuide(!showSpintaxGuide)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-bold text-amber-800 hover:bg-amber-100 transition-colors"
        >
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px]">shuffle</span>
            Spintax Guide — {spintaxCount} variation{spintaxCount !== 1 ? 's' : ''} in template
          </span>
          <span className="material-symbols-outlined text-[16px]">{showSpintaxGuide ? 'expand_less' : 'expand_more'}</span>
        </button>
        {showSpintaxGuide && (
          <div className="px-4 pb-4 pt-3 text-xs text-amber-700 space-y-2 border-t border-amber-200">
            <p><strong>Spintax</strong> creates unique email variations to avoid spam filters. Wrap alternatives in curly braces:</p>
            <code className="block bg-white/60 rounded-lg px-3 py-2 text-amber-900 font-mono">
              {'{Hi|Hello|Hey}'} {'{{company_name}}'}, {'{we noticed|I came across}'} your {'{rating|score}'}.
            </code>
            <p>Aim for 5+ spintax groups for best deliverability. Each email randomly picks one option per group.</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* ── Editor column ── */}
        <div className="space-y-4">

          {/* Subject */}
          <div>
            <label className="block text-sm font-bold text-on-surface mb-2">Subject Line</label>
            <div className="flex gap-1 mb-2 flex-wrap">
              {TOKENS.map((t) => (
                <button key={t} type="button" onClick={() => insertToken(t, 'subject')}
                  className="text-xs bg-surface-container hover:bg-surface-container-high px-2 py-0.5 rounded-full font-semibold text-secondary transition-colors">
                  +{t}
                </button>
              ))}
              {SPINTAX_EXAMPLES.slice(0, 2).map((s) => (
                <button key={s.label} type="button" onClick={() => insertSpintax(s.snippet, 'subject')}
                  className="text-xs bg-amber-50 hover:bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200 font-semibold transition-colors">
                  {s.label}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={subject}
              onChange={(e) => onChange({ subject: e.target.value })}
              className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/25 focus:outline-none"
            />
          </div>

          {/* Body */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-bold text-on-surface">Email Body (HTML)</label>
              <button
                type="button"
                onClick={handleGenerateWithAI}
                disabled={generating}
                className="flex items-center gap-1.5 bg-[#ffd9de] text-[#b0004a] px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-[#b0004a] hover:text-white transition-colors disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
                {generating ? 'Generating...' : 'Generate with AI'}
              </button>
            </div>
            {aiError && <p className="text-xs text-error mb-1">{aiError}</p>}
            <div className="flex gap-1 mb-2 flex-wrap">
              {TOKENS.map((t) => (
                <button key={t} type="button" onClick={() => insertToken(t, 'body')}
                  className="text-xs bg-surface-container hover:bg-surface-container-high px-2 py-0.5 rounded-full font-semibold text-secondary transition-colors">
                  +{t}
                </button>
              ))}
              {SPINTAX_EXAMPLES.map((s) => (
                <button key={s.label} type="button" onClick={() => insertSpintax(s.snippet, 'body')}
                  className="text-xs bg-amber-50 hover:bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200 font-semibold transition-colors">
                  {s.label}
                </button>
              ))}
            </div>
            <textarea
              value={body}
              onChange={(e) => onChange({ body: e.target.value })}
              rows={12}
              className="w-full bg-surface-container rounded-xl px-4 py-3 text-xs font-mono border-0 focus:ring-2 focus:ring-[#b0004a]/25 focus:outline-none resize-none"
            />
          </div>

          {/* Screenshot toggle */}
          <div
            className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
              includeScreenshot
                ? 'bg-[#ffd9de] border-[#b0004a]/20'
                : 'bg-surface-container border-slate-100'
            }`}
            onClick={() => onChange({ includeScreenshot: !includeScreenshot })}
          >
            <div className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${
              includeScreenshot ? 'primary-gradient' : 'bg-surface-container-high border border-slate-200'
            }`}>
              {includeScreenshot && <span className="material-symbols-outlined text-on-primary text-[12px]">check</span>}
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm font-bold text-on-surface cursor-pointer">
                <span className="material-symbols-outlined text-[16px] text-[#b0004a]">screenshot_monitor</span>
                Include Trustpilot Screenshot
              </label>
              <p className="text-xs text-secondary mt-0.5">Attach the company&apos;s Trustpilot profile screenshot showing their current rating.</p>
            </div>
          </div>
        </div>

        {/* ── Preview column — Actual Sent Message style ── */}
        <div className="space-y-3">

          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden ambient-shadow">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Message Preview
              </p>
              {spintaxCount > 0 && (
                <button
                  type="button"
                  onClick={() => setPreviewSeed(previewSeed + 1)}
                  className="flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 hover:bg-amber-100 px-2.5 py-1 rounded-full border border-amber-200 transition-colors"
                >
                  <span className="material-symbols-outlined text-[11px]">shuffle</span>
                  Randomize
                </button>
              )}
            </div>

            {/* Lead avatar + info */}
            <div className="px-4 pt-4 pb-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full primary-gradient flex items-center justify-center flex-shrink-0 text-on-primary text-sm font-extrabold">
                A
              </div>
              <div>
                <p className="text-sm font-bold text-on-surface">Acme Corp</p>
                <p className="text-xs text-secondary">contact@acme.com</p>
              </div>
            </div>

            {/* Subject */}
            <div className="px-4 pb-2">
              <p className="text-sm font-bold text-on-surface leading-snug">
                {resolvedSubject || <span className="text-slate-300 font-normal">No subject yet</span>}
              </p>
            </div>

            {/* Body */}
            <div className="px-4 pb-4 max-h-[220px] overflow-y-auto">
              <p className="text-xs text-secondary leading-relaxed whitespace-pre-wrap">
                {preview || <span className="text-slate-300">No content yet</span>}
              </p>
              {includeScreenshot && (
                <div className="mt-3 border-t border-slate-100 pt-3 flex items-center gap-2 text-secondary text-xs">
                  <span className="material-symbols-outlined text-[13px]">image</span>
                  <span>[Trustpilot screenshot attached]</span>
                </div>
              )}
            </div>

            {/* Metadata */}
            <div className="border-t border-slate-100 px-4 py-3">
              <p className="text-[10px] font-extrabold text-secondary uppercase tracking-wider mb-2">Metadata</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                <div>
                  <p className="text-[10px] text-secondary">Category</p>
                  <p className="text-xs font-semibold text-on-surface">{filterCategory || 'General'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-secondary">Country</p>
                  <p className="text-xs font-semibold text-on-surface">{filterCountry || 'All'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-secondary">Spintax Groups</p>
                  <p className="text-xs font-semibold text-on-surface">{spintaxCount}</p>
                </div>
                <div>
                  <p className="text-[10px] text-secondary">Status</p>
                  <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    subject && body ? 'text-[#006630] bg-[#e6f4ec]' : 'text-amber-700 bg-amber-50'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${subject && body ? 'bg-[#006630]' : 'bg-amber-400'}`} />
                    {subject && body ? 'Syntax Passed' : 'Incomplete'}
                  </span>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="border-t border-slate-100 px-4 py-3 flex gap-2">
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(`Subject: ${subject}\n\n${body.replace(/<[^>]+>/g, '')}`)}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold text-secondary border border-slate-200 rounded-lg py-2 hover:bg-surface-container transition-colors"
              >
                <span className="material-symbols-outlined text-[13px]">content_copy</span>
                Copy Message
              </button>
            </div>
          </div>

          {/* Optimization Suggestion */}
          {subject && body && spintaxCount === 0 && (
            <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
              <div className="flex items-start gap-3 p-4">
                <div className="w-7 h-7 rounded-xl bg-[#e6f4ec] flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-[14px] text-[#006630]">tips_and_updates</span>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-extrabold text-on-surface mb-1">Optimization Suggestion</p>
                  <p className="text-[11px] text-secondary leading-relaxed">
                    No spintax detected in your template. Adding variations like <code className="bg-surface-container px-1 rounded">{'{Hi|Hello|Hey}'}</code> improves deliverability and reduces spam detection.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (!subject.includes('{')) {
                        onChange({ subject: `{Scale|Improve|Strengthen} your reputation, {{company_name}}` });
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

        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Plus, ImageIcon, Sparkles, Shuffle, ChevronDown, ChevronUp } from 'lucide-react';
import { generateEmailTemplate } from '../../lib/gemini';

const TOKENS = ['{{company_name}}', '{{website_url}}', '{{star_rating}}', '{{category}}', '{{country}}'];

const SPINTAX_EXAMPLES = [
  { label: 'Greeting', snippet: '{Hi|Hello|Hey}' },
  { label: 'Opening', snippet: '{We noticed|I came across|Our team spotted}' },
  { label: 'CTA', snippet: '{Would you be open to|Could we schedule|How about}' },
  { label: 'Closing', snippet: '{Best regards|Kind regards|Best}' },
];

/**
 * Resolves spintax {option1|option2|option3} for preview rendering.
 * Picks one random option per group (client-side preview only).
 */
function resolveSpintaxPreview(text: string): string {
  let result = text;
  let max = 50;
  while (max-- > 0) {
    const match = result.match(/\{([^{}]+)\}/);
    if (!match) break;
    const options = match[1].split('|');
    const chosen = options[Math.floor(Math.random() * options.length)];
    result = result.replace(match[0], chosen);
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
      const html = await generateEmailTemplate({
        country: filterCountry || undefined,
        category: filterCategory || undefined,
      });
      onChange({ body: html });
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

  // Build preview: tokens FIRST, then spintax — must match server render order (renderAndSpin)
  // If spintax runs first, {{company_name}} gets eaten because the inner {company_name} matches the regex
  const sampleData: Record<string, string> = {
    company_name: 'Acme Corp',
    website_url: 'acme.com',
    star_rating: '2.5',
    category: 'casino',
    country: 'DE',
  };

  const applyTokens = (text: string) =>
    text.replace(/\{\{(\w+)\}\}/g, (_, key) => sampleData[key] ?? `{{${key}}}`);

  // previewSeed in the expression ensures a fresh random roll each time Randomize is clicked
  const resolvedBody = resolveSpintaxPreview(applyTokens(body) + (previewSeed < 0 ? '' : ''));
  const resolvedSubject = resolveSpintaxPreview(applyTokens(subject) + (previewSeed < 0 ? '' : ''));

  const preview = resolvedBody
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const subjectPreview = resolvedSubject;

  // Count spintax groups in the template
  const spintaxCount = (body.match(/\{[^{}]+\}/g) || []).length + (subject.match(/\{[^{}]+\}/g) || []).length;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold mb-1">Email Template</h3>
        <p className="text-sm text-gray-500">Compose your outreach email. Use tokens to personalize and spintax for unique variations.</p>
      </div>

      {/* Spintax Guide (collapsible) */}
      <div className="border border-amber-200 bg-amber-50 rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setShowSpintaxGuide(!showSpintaxGuide)}
          className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-amber-800 hover:bg-amber-100 transition-colors"
        >
          <span className="flex items-center gap-2">
            <Shuffle size={14} />
            Spintax Guide — {spintaxCount} variation{spintaxCount !== 1 ? 's' : ''} in template
          </span>
          {showSpintaxGuide ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {showSpintaxGuide && (
          <div className="px-4 pb-3 text-xs text-amber-700 space-y-2 border-t border-amber-200 pt-3">
            <p>
              <strong>Spintax</strong> creates unique email variations to avoid spam filters.
              Wrap alternatives in curly braces separated by pipes:
            </p>
            <code className="block bg-white/60 rounded px-3 py-2 text-amber-900 font-mono">
              {'{Hi|Hello|Hey}'} {'{{company_name}}'}, {'{we noticed|I came across}'} your {'{rating|score}'}.
            </code>
            <p>Each email randomly picks one option per group, creating thousands of unique combinations.</p>
            <p className="text-amber-600">
              <strong>Tip:</strong> More spintax groups = more unique emails = better deliverability. Aim for 5+ groups.
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Editor */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subject Line</label>
            <div className="flex gap-1 mb-1.5 flex-wrap">
              {TOKENS.map((t) => (
                <button key={t} type="button" onClick={() => insertToken(t, 'subject')}
                  className="text-xs bg-gray-100 hover:bg-gray-200 px-2 py-0.5 rounded transition-colors">
                  <Plus size={9} className="inline mr-0.5" />{t}
                </button>
              ))}
              <span className="text-gray-300 mx-0.5">|</span>
              {SPINTAX_EXAMPLES.slice(0, 2).map((s) => (
                <button key={s.label} type="button" onClick={() => insertSpintax(s.snippet, 'subject')}
                  className="text-xs bg-amber-50 hover:bg-amber-100 text-amber-700 px-2 py-0.5 rounded border border-amber-200 transition-colors">
                  <Shuffle size={9} className="inline mr-0.5" />{s.label}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={subject}
              onChange={(e) => onChange({ subject: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">Email Body (HTML)</label>
              <button
                type="button"
                onClick={handleGenerateWithAI}
                disabled={generating}
                className="flex items-center gap-1.5 border border-indigo-300 text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50"
              >
                <Sparkles size={13} />
                {generating ? 'Generating...' : 'Generate with AI'}
              </button>
            </div>
            {aiError && <p className="text-xs text-red-600 mb-1">{aiError}</p>}
            <div className="flex gap-1 mb-1.5 flex-wrap">
              {TOKENS.map((t) => (
                <button key={t} type="button" onClick={() => insertToken(t, 'body')}
                  className="text-xs bg-gray-100 hover:bg-gray-200 px-2 py-0.5 rounded transition-colors">
                  <Plus size={9} className="inline mr-0.5" />{t}
                </button>
              ))}
              <span className="text-gray-300 mx-0.5">|</span>
              {SPINTAX_EXAMPLES.map((s) => (
                <button key={s.label} type="button" onClick={() => insertSpintax(s.snippet, 'body')}
                  className="text-xs bg-amber-50 hover:bg-amber-100 text-amber-700 px-2 py-0.5 rounded border border-amber-200 transition-colors">
                  <Shuffle size={9} className="inline mr-0.5" />{s.label}
                </button>
              ))}
            </div>
            <textarea
              value={body}
              onChange={(e) => onChange({ body: e.target.value })}
              rows={12}
              className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm font-mono text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-xl border border-gray-200">
            <input
              id="wizard-screenshot"
              type="checkbox"
              checked={includeScreenshot}
              onChange={(e) => onChange({ includeScreenshot: e.target.checked })}
              className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <div>
              <label htmlFor="wizard-screenshot" className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                <ImageIcon size={15} className="text-blue-500" />
                Include Trustpilot Screenshot
              </label>
              <p className="text-xs text-gray-500 mt-0.5">Attach the company's Trustpilot profile screenshot showing their current rating.</p>
            </div>
          </div>
        </div>

        {/* Preview */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-700">Preview (sample data)</label>
            {spintaxCount > 0 && (
              <button
                type="button"
                onClick={() => setPreviewSeed(previewSeed + 1)}
                className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 px-2.5 py-1 rounded-lg border border-amber-200 transition-colors"
              >
                <Shuffle size={11} />
                Randomize
              </button>
            )}
          </div>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
            <div className="px-4 py-3 border-b bg-gray-50 rounded-t-xl">
              <p className="text-xs text-gray-500">To: contact@acme.com</p>
              <p className="text-sm font-medium text-gray-800 mt-0.5">
                {subjectPreview}
              </p>
            </div>
            <div className="p-4 text-sm text-gray-700 whitespace-pre-wrap max-h-[400px] overflow-y-auto">
              {preview}
              {includeScreenshot && (
                <div className="mt-3 border-t border-gray-200 pt-3">
                  <div className="flex items-center gap-2 text-gray-400 text-xs">
                    <ImageIcon size={14} />
                    <span>[Trustpilot profile screenshot attached]</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          {spintaxCount > 0 && (
            <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
              <Shuffle size={11} />
              {spintaxCount} spintax group{spintaxCount !== 1 ? 's' : ''} detected — click "Randomize" to preview different variations
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

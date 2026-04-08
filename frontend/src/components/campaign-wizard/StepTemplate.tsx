import { useState } from 'react';
import { Plus, ImageIcon, Sparkles } from 'lucide-react';
import { generateEmailTemplate } from '../../lib/gemini';

const TOKENS = ['{{company_name}}', '{{website_url}}', '{{star_rating}}', '{{category}}', '{{country}}'];

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

  const preview = body
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{company_name\}\}/g, 'Acme Corp')
    .replace(/\{\{website_url\}\}/g, 'acme.com')
    .replace(/\{\{star_rating\}\}/g, '2.5')
    .replace(/\{\{category\}\}/g, 'casino')
    .replace(/\{\{country\}\}/g, 'DE')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold mb-1">Email Template</h3>
        <p className="text-sm text-gray-500">Compose your outreach email. Use tokens to personalize for each lead.</p>
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
          <label className="block text-sm font-medium text-gray-700 mb-1">Preview (sample data)</label>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
            <div className="px-4 py-3 border-b bg-gray-50 rounded-t-xl">
              <p className="text-xs text-gray-500">To: contact@acme.com</p>
              <p className="text-sm font-medium text-gray-800 mt-0.5">
                {subject
                  .replace(/\{\{company_name\}\}/g, 'Acme Corp')
                  .replace(/\{\{star_rating\}\}/g, '2.5')
                  .replace(/\{\{category\}\}/g, 'casino')
                  .replace(/\{\{country\}\}/g, 'DE')
                  .replace(/\{\{website_url\}\}/g, 'acme.com')}
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
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Send, Plus, ImageIcon, Users, Sparkles } from 'lucide-react';
import { generateEmailTemplate } from '../lib/gemini';

const TOKENS = ['{{company_name}}', '{{website_url}}', '{{star_rating}}', '{{review_count}}', '{{category}}', '{{country}}'];

const DEFAULT_SUBJECT = 'Your Trustpilot rating needs attention, {{company_name}}';

const DEFAULT_BODY = `<p>Hi,</p>

<p>We recently noticed your brand's Trustpilot score isn't where it should be, with a relatively low overall rating (see details below). Our team can help you improve your Trustpilot score by boosting positive visibility, achieving a green rating, and enhancing your brand's credibility and trustworthy online image.</p>

<p><strong>{{company_name}}</strong><br>
Reviews: {{review_count}}<br>
Rate: {{star_rating}}</p>

<p>Would you be open to a quick chat to see how we can clean up your Trustpilot presence and strengthen your online reputation?</p>

<p>Best regards,<br>
OptiRate</p>
<p>www.optiratesolutions.com</p>`;

const COUNTRIES = [
  { code: '', name: 'All Countries' },
  { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' }, { code: 'CA', name: 'Canada' },
  { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' }, { code: 'DK', name: 'Denmark' },
  { code: 'SE', name: 'Sweden' }, { code: 'NO', name: 'Norway' },
  { code: 'FI', name: 'Finland' }, { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' }, { code: 'BR', name: 'Brazil' },
];

const CATEGORIES = [
  { slug: '', name: 'All Categories' },
  // Gambling
  { slug: 'gambling', name: 'Gambling (all)' },
  { slug: 'casino', name: 'Casino' },
  { slug: 'online_casino_or_bookmaker', name: 'Online Casino / Bookmaker' },
  { slug: 'online_sports_betting', name: 'Online Sports Betting' },
  { slug: 'betting_agency', name: 'Betting Agency' },
  { slug: 'bookmaker', name: 'Bookmaker' },
  { slug: 'gambling_service', name: 'Gambling Service' },
  { slug: 'gambling_house', name: 'Gambling House' },
  { slug: 'off_track_betting_shop', name: 'Off-Track Betting Shop' },
  { slug: 'lottery_vendor', name: 'Lottery Vendor' },
  { slug: 'online_lottery_ticket_vendor', name: 'Online Lottery Vendor' },
  { slug: 'lottery_retailer', name: 'Lottery Retailer' },
  { slug: 'lottery_shop', name: 'Lottery Shop' },
  { slug: 'gambling_instructor', name: 'Gambling Instructor' },
  // Gaming
  { slug: 'gaming', name: 'Gaming (all)' },
  { slug: 'gaming_service_provider', name: 'Gaming Service Provider' },
  { slug: 'bingo_hall', name: 'Bingo Hall' },
  { slug: 'video_game_store', name: 'Video Game Store' },
  { slug: 'game_store', name: 'Game Store' },
  // Finance
  { slug: 'bank', name: 'Bank' },
  { slug: 'insurance_agency', name: 'Insurance Agency' },
  { slug: 'money_transfer_service', name: 'Money Transfer' },
  // Other
  { slug: 'electronics_technology', name: 'Electronics & Technology' },
  { slug: 'travel_vacation', name: 'Travel & Vacation' },
];

interface Props {
  onSubmit: (data: {
    name: string;
    templateSubject: string;
    templateBody: string;
    includeScreenshot: boolean;
    filterCountry?: string;
    filterCategory?: string;
  }) => Promise<void>;
}

export default function CampaignBuilder({ onSubmit }: Props) {
  const [name, setName] = useState('');
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [filterCountry, setFilterCountry] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [saving, setSaving] = useState(false);
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
      setBody(html);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI generation failed. Try again.');
    } finally {
      setGenerating(false);
    }
  };

  const insertToken = (token: string, field: 'subject' | 'body') => {
    if (field === 'subject') setSubject((prev) => prev + token);
    else setBody((prev) => prev + token);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !subject || !body) return;
    setSaving(true);
    await onSubmit({ name, templateSubject: subject, templateBody: body, includeScreenshot, filterCountry, filterCategory });
    setName('');
    setSubject(DEFAULT_SUBJECT);
    setBody(DEFAULT_BODY);
    setFilterCountry('');
    setFilterCategory('');
    setSaving(false);
  };

  // Simple preview — strips HTML tags for plain preview
  const preview = body
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{company_name\}\}/g, 'Acme Corp')
    .replace(/\{\{website_url\}\}/g, 'acme.com')
    .replace(/\{\{star_rating\}\}/g, '2.5')
    .replace(/\{\{review_count\}\}/g, '142')
    .replace(/\{\{category\}\}/g, 'casino')
    .replace(/\{\{country\}\}/g, 'DE')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const targetLabel = (() => {
    const parts = [];
    if (filterCountry) parts.push(COUNTRIES.find((c) => c.code === filterCountry)?.name || filterCountry);
    if (filterCategory) parts.push(CATEGORIES.find((c) => c.slug === filterCategory)?.name || filterCategory);
    return parts.length > 0 ? parts.join(' · ') : 'All scraped leads';
  })();

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold mb-4">Create Campaign</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Campaign Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Casino DE — April 2026"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm" />
        </div>

        {/* Target Audience */}
        <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
          <div className="flex items-center gap-2 mb-3">
            <Users size={15} className="text-blue-600" />
            <label className="text-sm font-medium text-blue-800">Target Audience</label>
          </div>
          <p className="text-xs text-blue-600 mb-3">
            All leads matching this filter will automatically be added to the campaign.
          </p>
          <div className="flex gap-3 flex-wrap">
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs text-gray-600 mb-1">Country</label>
              <select value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white">
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[160px]">
              <label className="block text-xs text-gray-600 mb-1">Category</label>
              <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white">
                {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <p className="text-xs text-blue-700 mt-2 font-medium">
            Will target: {targetLabel}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email Subject</label>
          <div className="flex gap-1 mb-1 flex-wrap">
            {TOKENS.map((t) => (
              <button key={t} type="button" onClick={() => insertToken(t, 'subject')}
                className="text-xs bg-gray-100 hover:bg-gray-200 px-2 py-0.5 rounded">
                <Plus size={10} className="inline" /> {t}
              </button>
            ))}
          </div>
          <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm" />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-700">Email Body (HTML)</label>
            <button
              type="button"
              onClick={handleGenerateWithAI}
              disabled={generating}
              className="flex items-center gap-1.5 border border-indigo-300 text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-md text-xs font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50"
            >
              <Sparkles size={13} />
              {generating ? 'Generating...' : 'Generate with AI'}
            </button>
          </div>
          {aiError && (
            <p className="text-xs text-red-600 mb-1">{aiError}</p>
          )}
          <div className="flex gap-1 mb-1 flex-wrap">
            {TOKENS.map((t) => (
              <button key={t} type="button" onClick={() => insertToken(t, 'body')}
                className="text-xs bg-gray-100 hover:bg-gray-200 px-2 py-0.5 rounded">
                <Plus size={10} className="inline" /> {t}
              </button>
            ))}
          </div>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono text-xs" />
          <p className="text-xs text-gray-400 mt-1">
            Tip: Select a Country and Category above first for a more targeted AI-generated template.
          </p>
        </div>

        {/* Screenshot Toggle */}
        <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center h-5 mt-0.5">
            <input
              id="include-screenshot"
              type="checkbox"
              checked={includeScreenshot}
              onChange={(e) => setIncludeScreenshot(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
          </div>
          <div className="flex-1">
            <label htmlFor="include-screenshot" className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
              <ImageIcon size={16} className="text-blue-500" />
              Include Trustpilot Profile Screenshot
            </label>
            <p className="text-xs text-gray-500 mt-1">
              Attach the company's Trustpilot profile screenshot to the email to show their current rating.
            </p>
          </div>
        </div>

        {/* Preview */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Preview (sample data)</label>
          <div className="bg-gray-50 rounded border border-gray-200 p-3 text-sm whitespace-pre-wrap text-gray-700">
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

        <button type="submit" disabled={saving || !name || !subject || !body}
          className="inline-flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50">
          <Send size={16} />
          {saving ? 'Creating...' : 'Create Campaign'}
        </button>
      </div>
    </form>
  );
}

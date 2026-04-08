import { Mail, Users, ImageIcon, Send } from 'lucide-react';
import { COUNTRIES, CATEGORIES } from './StepSetup';

interface Props {
  name: string;
  subject: string;
  body: string;
  includeScreenshot: boolean;
  filterCountry: string;
  filterCategory: string;
  recipientCount: number;
  saving: boolean;
  onSubmit: () => void;
}

export default function StepReview({
  name, subject, body, includeScreenshot,
  filterCountry, filterCategory, recipientCount,
  saving, onSubmit,
}: Props) {
  const countryName = COUNTRIES.find((c) => c.code === filterCountry)?.name || 'All Countries';
  const categoryName = CATEGORIES.find((c) => c.slug === filterCategory)?.name || 'All Categories';

  const bodyPreview = body.replace(/<[^>]+>/g, '').slice(0, 150).trim();

  return (
    <div className="space-y-5 max-w-xl mx-auto">
      <div>
        <h3 className="text-lg font-semibold mb-1">Review & Create</h3>
        <p className="text-sm text-gray-500">Confirm everything looks good before creating your campaign.</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 divide-y">
        {/* Name */}
        <div className="px-5 py-4">
          <p className="text-xs text-gray-500 mb-0.5">Campaign Name</p>
          <p className="text-sm font-semibold text-gray-900">{name}</p>
        </div>

        {/* Target */}
        <div className="px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <Users size={14} className="text-blue-500" />
            <p className="text-xs text-gray-500">Recipients</p>
          </div>
          <p className="text-sm font-semibold text-blue-700">{recipientCount} lead{recipientCount !== 1 ? 's' : ''} selected</p>
          {(filterCountry || filterCategory) && (
            <p className="text-xs text-gray-400 mt-0.5">Filtered by: {countryName}{filterCountry && filterCategory ? ' + ' : ''}{filterCategory ? categoryName : ''}</p>
          )}
        </div>

        {/* Subject */}
        <div className="px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <Mail size={14} className="text-blue-500" />
            <p className="text-xs text-gray-500">Subject Line</p>
          </div>
          <p className="text-sm text-gray-800">{subject}</p>
        </div>

        {/* Body preview */}
        <div className="px-5 py-4">
          <p className="text-xs text-gray-500 mb-1">Body Preview</p>
          <p className="text-sm text-gray-600">{bodyPreview}{body.length > 150 ? '...' : ''}</p>
        </div>

        {/* Screenshot */}
        {includeScreenshot && (
          <div className="px-5 py-3 bg-blue-50">
            <div className="flex items-center gap-2 text-xs text-blue-700">
              <ImageIcon size={13} />
              <span>Trustpilot screenshot will be attached</span>
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={saving || recipientCount === 0}
        className="w-full flex items-center justify-center gap-2 bg-green-600 text-white px-5 py-3 rounded-xl text-sm font-semibold hover:bg-green-700 disabled:opacity-50 transition-colors"
      >
        <Send size={16} />
        {saving ? 'Creating Campaign...' : 'Create Campaign'}
      </button>

      {recipientCount === 0 && (
        <p className="text-xs text-center text-red-500">
          No leads selected. Go back to Step 3 and select at least one lead.
        </p>
      )}

      <p className="text-xs text-center text-gray-400">
        The campaign will be created as a Draft. You can send a test or go live from the campaign list.
      </p>
    </div>
  );
}

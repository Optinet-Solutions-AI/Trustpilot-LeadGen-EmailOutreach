import { COUNTRIES, CATEGORIES } from './StepSetup';

interface Props {
  name: string;
  subject: string;
  body: string;
  includeScreenshot: boolean;
  filterCountry: string;
  filterCategory: string;
  recipientCount: number;
  followUpCount?: number;
  saving: boolean;
  onSubmit: () => void;
}

export default function StepReview({
  name, subject, body, includeScreenshot,
  filterCountry, filterCategory, recipientCount,
  followUpCount = 0, saving, onSubmit,
}: Props) {
  const countryName  = COUNTRIES.find((c) => c.code === filterCountry)?.name  || 'All Countries';
  const categoryName = CATEGORIES.find((c) => c.slug === filterCategory)?.name || 'All Categories';
  const bodyPreview  = body.replace(/<[^>]+>/g, '').slice(0, 180).trim();

  const items = [
    {
      icon: 'badge',
      label: 'Campaign Name',
      value: name,
      accent: false,
    },
    {
      icon: 'group',
      label: 'Recipients',
      value: `${recipientCount} lead${recipientCount !== 1 ? 's' : ''} selected`,
      sub: (filterCountry || filterCategory)
        ? `Filtered by: ${countryName}${filterCountry && filterCategory ? ' + ' : ''}${filterCategory ? categoryName : ''}`
        : null,
      accent: recipientCount > 0,
    },
    {
      icon: 'subject',
      label: 'Subject Line',
      value: subject,
      accent: false,
    },
    {
      icon: 'edit_note',
      label: 'Body Preview',
      value: bodyPreview + (body.length > 180 ? '…' : ''),
      accent: false,
    },
  ];

  return (
    <div className="space-y-5">

      {/* Header */}
      <div>
        <h3
          className="text-xl font-extrabold text-on-surface"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Review & Create
        </h3>
        <p className="text-sm text-secondary mt-0.5">Confirm everything looks good before creating your campaign.</p>
      </div>

      {/* Summary card */}
      <div className="bg-surface-container-lowest rounded-xl border border-slate-100 ambient-shadow divide-y divide-slate-100 overflow-hidden">
        {items.map((item) => (
          <div key={item.label} className="px-5 py-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-[15px] text-secondary">{item.icon}</span>
              <p className="text-xs font-bold text-secondary uppercase tracking-wider">{item.label}</p>
            </div>
            <p className={`text-sm font-semibold ${item.accent ? 'text-[#b0004a]' : 'text-on-surface'}`}>
              {item.value}
            </p>
            {item.sub && <p className="text-xs text-secondary mt-0.5">{item.sub}</p>}
          </div>
        ))}

        {/* Follow-ups */}
        {followUpCount > 0 && (
          <div className="px-5 py-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-[15px] text-secondary">schedule_send</span>
              <p className="text-xs font-bold text-secondary uppercase tracking-wider">Follow-up Sequence</p>
            </div>
            <p className="text-sm font-semibold text-on-surface">
              {followUpCount} follow-up email{followUpCount !== 1 ? 's' : ''} configured
            </p>
            <p className="text-xs text-secondary mt-0.5">
              Leads who don&apos;t reply will receive follow-ups automatically
            </p>
          </div>
        )}

        {/* Screenshot */}
        {includeScreenshot && (
          <div className="px-5 py-3 bg-[#ffd9de]/30 flex items-center gap-2">
            <span className="material-symbols-outlined text-[#b0004a] text-[16px]">screenshot_monitor</span>
            <span className="text-xs font-bold text-[#b0004a]">Trustpilot screenshot will be attached to each email</span>
          </div>
        )}
      </div>

      {/* Warning if no leads */}
      {recipientCount === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
          <span className="material-symbols-outlined text-amber-600 text-[20px]">warning</span>
          <p className="text-sm font-bold text-amber-800">
            No leads selected. Go back to Step 4 and select at least one lead.
          </p>
        </div>
      )}

      {/* Submit */}
      <button
        type="button"
        onClick={onSubmit}
        disabled={saving || recipientCount === 0}
        className="w-full flex items-center justify-center gap-2 primary-gradient text-on-primary px-5 py-4 rounded-xl text-sm font-extrabold ambient-shadow hover:scale-[1.01] disabled:opacity-50 disabled:scale-100 transition-transform"
        style={{ fontFamily: 'Manrope, sans-serif' }}
      >
        <span className="material-symbols-outlined text-[20px]">{saving ? 'progress_activity' : 'rocket_launch'}</span>
        {saving ? 'Creating Campaign...' : 'Create Campaign'}
      </button>

      <p className="text-xs text-center text-secondary">
        Campaign will be created as a <span className="font-bold">Draft</span>.
        You can send a test or go live from the campaign list.
      </p>
    </div>
  );
}

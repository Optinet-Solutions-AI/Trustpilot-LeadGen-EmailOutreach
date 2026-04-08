import { Users } from 'lucide-react';

export const COUNTRIES = [
  { code: '', name: 'All Countries' },
  { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' }, { code: 'CA', name: 'Canada' },
  { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' }, { code: 'DK', name: 'Denmark' },
  { code: 'SE', name: 'Sweden' }, { code: 'NO', name: 'Norway' },
  { code: 'FI', name: 'Finland' }, { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' }, { code: 'BR', name: 'Brazil' },
];

export const CATEGORIES = [
  { slug: '', name: 'All Categories' },
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
  { slug: 'gaming', name: 'Gaming (all)' },
  { slug: 'gaming_service_provider', name: 'Gaming Service Provider' },
  { slug: 'bingo_hall', name: 'Bingo Hall' },
  { slug: 'video_game_store', name: 'Video Game Store' },
  { slug: 'game_store', name: 'Game Store' },
  { slug: 'bank', name: 'Bank' },
  { slug: 'insurance_agency', name: 'Insurance Agency' },
  { slug: 'money_transfer_service', name: 'Money Transfer' },
  { slug: 'electronics_technology', name: 'Electronics & Technology' },
  { slug: 'travel_vacation', name: 'Travel & Vacation' },
];

interface Props {
  name: string;
  filterCountry: string;
  filterCategory: string;
  onChange: (patch: { name?: string; filterCountry?: string; filterCategory?: string }) => void;
}

export default function StepSetup({ name, filterCountry, filterCategory, onChange }: Props) {
  const targetLabel = (() => {
    const parts: string[] = [];
    if (filterCountry) parts.push(COUNTRIES.find((c) => c.code === filterCountry)?.name || filterCountry);
    if (filterCategory) parts.push(CATEGORIES.find((c) => c.slug === filterCategory)?.name || filterCategory);
    return parts.length > 0 ? parts.join(' + ') : 'All scraped leads with a valid email';
  })();

  return (
    <div className="space-y-6 max-w-xl mx-auto">
      <div>
        <h3 className="text-lg font-semibold mb-1">Campaign Setup</h3>
        <p className="text-sm text-gray-500">Name your campaign and choose your target audience.</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">Campaign Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Casino DE — April 2026"
          className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          autoFocus
        />
      </div>

      <div className="p-5 bg-blue-50 rounded-xl border border-blue-100">
        <div className="flex items-center gap-2 mb-3">
          <Users size={16} className="text-blue-600" />
          <label className="text-sm font-semibold text-blue-800">Target Audience</label>
        </div>
        <p className="text-xs text-blue-600 mb-4">
          Used to pre-filter leads in Step 3 — you'll choose exactly which ones to include.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Country</label>
            <select
              value={filterCountry}
              onChange={(e) => onChange({ filterCountry: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500"
            >
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
            <select
              value={filterCategory}
              onChange={(e) => onChange({ filterCategory: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500"
            >
              {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-blue-700 mt-3 font-medium">
          Pre-filter for Step 3: {targetLabel}
        </p>
      </div>
    </div>
  );
}

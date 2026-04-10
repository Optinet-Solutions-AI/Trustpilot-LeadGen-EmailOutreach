import { Users, Clock } from 'lucide-react';

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

// Only timezones confirmed in Instantly's allowed enum (not all IANA zones are accepted).
// Ref: https://developer.instantly.ai/api/v2/campaign/createcampaign
export const TIMEZONES = [
  { value: 'America/Detroit',      label: 'US Eastern — New York, Miami (EST/EDT)' },
  { value: 'America/Chicago',      label: 'US Central — Chicago, Dallas (CST/CDT)' },
  { value: 'America/Boise',        label: 'US Mountain — Denver, Phoenix (MST/MDT)' },
  { value: 'America/Anchorage',    label: 'US Alaska (AKST/AKDT)' },
  { value: 'America/Bogota',       label: 'Colombia / Lima (UTC-5, no DST)' },
  { value: 'America/Sao_Paulo',    label: 'Brazil / Buenos Aires (UTC-3)' },
  { value: 'Europe/Belfast',       label: 'UK / Ireland — London, Dublin (GMT/BST)' },
  { value: 'Europe/Belgrade',      label: 'Central Europe — Paris, Berlin, Amsterdam (CET/CEST)' },
  { value: 'Europe/Bucharest',     label: 'Eastern Europe — Athens, Kyiv (EET/EEST)' },
  { value: 'Asia/Dubai',           label: 'Gulf — Dubai, Abu Dhabi (UTC+4)' },
  { value: 'Asia/Kolkata',         label: 'India (IST, UTC+5:30)' },
  { value: 'Asia/Hong_Kong',       label: 'Philippines / Hong Kong (UTC+8)' },
  { value: 'Asia/Brunei',          label: 'Singapore / Malaysia (UTC+8)' },
  { value: 'Australia/Melbourne',  label: 'Sydney / Melbourne (AEST/AEDT)' },
  { value: 'Pacific/Auckland',     label: 'New Zealand (NZST/NZDT)' },
];

export const HOURS = [
  '06:00','07:00','08:00','09:00','10:00','11:00',
  '12:00','13:00','14:00','15:00','16:00','17:00',
  '18:00','19:00','20:00',
];

const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export interface SendingSchedule {
  timezone: string;
  startHour: string;
  endHour: string;
  days: number[];     // 0=Sun…6=Sat
  dailyLimit: number;
}

export const DEFAULT_SCHEDULE: SendingSchedule = {
  timezone: 'America/Detroit',  // US Eastern — valid in Instantly's timezone enum
  startHour: '09:00',
  endHour: '17:00',
  days: [1, 2, 3, 4, 5],  // Mon–Fri
  dailyLimit: 50,
};

interface Props {
  name: string;
  filterCountry: string;
  filterCategory: string;
  schedule: SendingSchedule;
  onChange: (patch: { name?: string; filterCountry?: string; filterCategory?: string; schedule?: SendingSchedule }) => void;
}

export default function StepSetup({ name, filterCountry, filterCategory, schedule, onChange }: Props) {
  const updateSchedule = (patch: Partial<SendingSchedule>) =>
    onChange({ schedule: { ...schedule, ...patch } });

  const toggleDay = (day: number) => {
    const days = schedule.days.includes(day)
      ? schedule.days.filter((d) => d !== day)
      : [...schedule.days, day].sort();
    updateSchedule({ days });
  };
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

      {/* Sending Schedule */}
      <div className="p-5 bg-gray-50 rounded-xl border border-gray-200">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={16} className="text-gray-500" />
          <label className="text-sm font-semibold text-gray-700">Sending Schedule</label>
          <span className="text-xs text-gray-400 font-normal">(Instantly platform)</span>
        </div>
        <div className="text-xs text-gray-500 mb-4 space-y-1.5">
          <p>Instantly sends emails from your configured accounts within this window only. Outside these hours they queue and go out at the next opening.</p>
          <p className="text-blue-600 font-medium">💡 How it works: Instantly spreads your daily limit evenly across the window. Example: 50 emails/day between 9:00–17:00 = roughly 1 email every 10 minutes.</p>
          <p className="text-green-600 font-medium">✓ Test flights always send immediately — they bypass this schedule entirely.</p>
        </div>

        <div className="space-y-4">
          {/* Timezone */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Timezone</label>
            <select
              value={schedule.timezone}
              onChange={(e) => updateSchedule({ timezone: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
          </div>

          {/* Sending hours */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Start Hour</label>
              <select
                value={schedule.startHour}
                onChange={(e) => updateSchedule({ startHour: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500"
              >
                {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">End Hour</label>
              <select
                value={schedule.endHour}
                onChange={(e) => updateSchedule({ endHour: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500"
              >
                {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>

          {/* Days of week */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">Active Days</label>
            <div className="flex gap-1.5">
              {DAY_LABELS.map((label, day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  className={`w-9 h-9 rounded-lg text-xs font-medium transition-colors ${
                    schedule.days.includes(day)
                      ? 'bg-blue-600 text-white'
                      : 'bg-white border border-gray-300 text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Daily limit */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Daily Email Limit <span className="text-gray-400 font-normal">(per sending account)</span>
            </label>
            <input
              type="number"
              min={5}
              max={500}
              value={schedule.dailyLimit}
              onChange={(e) => updateSchedule({ dailyLimit: Number(e.target.value) })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              Warmup guide: Week 1 → 20/day · Week 2 → 50/day · Week 3+ → 100+/day.
              Start low to protect your sender reputation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

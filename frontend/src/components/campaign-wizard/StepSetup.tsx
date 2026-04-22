import { useState } from 'react';

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

// Only timezones confirmed in Instantly's allowed enum
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

// Full 24-hour list. Use '23:59' for end-of-day if you want a true 24h window.
export const HOURS = [
  '00:00','01:00','02:00','03:00','04:00','05:00',
  '06:00','07:00','08:00','09:00','10:00','11:00',
  '12:00','13:00','14:00','15:00','16:00','17:00',
  '18:00','19:00','20:00','21:00','22:00','23:00',
  '23:59',
];

const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export interface SendingSchedule {
  timezone: string;
  startHour: string;
  endHour: string;
  days: number[];
  dailyLimit: number;
}

export const DEFAULT_SCHEDULE: SendingSchedule = {
  timezone: 'America/Detroit',
  startHour: '09:00',
  endHour: '17:00',
  days: [1, 2, 3, 4, 5],
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
  const [scheduleOpen, setScheduleOpen] = useState(false);

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
    <div className="space-y-6">

      {/* Section header */}
      <div>
        <h3
          className="text-xl font-extrabold text-on-surface"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Campaign Setup
        </h3>
        <p className="text-sm text-secondary mt-0.5">Name your campaign and choose your target audience.</p>
      </div>

      {/* Campaign Name */}
      <div>
        <label className="block text-sm font-bold text-on-surface mb-2">Campaign Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Casino DE — April 2026"
          autoFocus
          className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm font-medium border-0 focus:ring-2 focus:ring-[#b0004a]/25 focus:outline-none placeholder:text-slate-400"
        />
      </div>

      {/* Target Audience */}
      <div className="bg-surface-container rounded-xl p-5">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-7 h-7 rounded-lg bg-[#ffd9de] flex items-center justify-center">
            <span className="material-symbols-outlined text-[#b0004a] text-[15px]">group</span>
          </div>
          <p className="text-sm font-bold text-on-surface">Target Audience</p>
        </div>
        <p className="text-xs text-secondary mb-4 ml-9">
          Used to pre-filter leads in Step 4 — you&apos;ll choose exactly which ones to include.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">Country</label>
            <select
              value={filterCountry}
              onChange={(e) => onChange({ filterCountry: e.target.value })}
              className="w-full bg-surface-container-lowest rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
            >
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">Category</label>
            <select
              value={filterCategory}
              onChange={(e) => onChange({ filterCategory: e.target.value })}
              className="w-full bg-surface-container-lowest rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
            >
              {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-secondary mt-3 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[#b0004a] text-[14px]">filter_alt</span>
          Pre-filter for Step 4: <span className="font-bold text-on-surface">{targetLabel}</span>
        </p>
      </div>

      {/* Sending Schedule — collapsible */}
      <div className="bg-surface-container rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setScheduleOpen(!scheduleOpen)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface-container-high transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-surface-container-high flex items-center justify-center">
              <span className="material-symbols-outlined text-secondary text-[15px]">schedule</span>
            </div>
            <div className="text-left">
              <p className="text-sm font-bold text-on-surface">Sending Schedule</p>
              <p className="text-xs text-secondary">
                {schedule.startHour}–{schedule.endHour} · {schedule.days.length} days/week · {schedule.dailyLimit}/day
              </p>
            </div>
          </div>
          <span className="material-symbols-outlined text-secondary text-[20px]">
            {scheduleOpen ? 'expand_less' : 'expand_more'}
          </span>
        </button>

        {scheduleOpen && (
          <div className="px-5 pb-5 border-t border-slate-100 space-y-5 pt-4">
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-xs text-blue-700 space-y-1">
              <p>Instantly sends emails within this window only. Outside these hours they queue for the next opening.</p>
              <p className="font-semibold text-[#006630]">✓ Test flights always send immediately — they bypass this schedule.</p>
            </div>

            {/* Timezone */}
            <div>
              <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">Timezone</label>
              <select
                value={schedule.timezone}
                onChange={(e) => updateSchedule({ timezone: e.target.value })}
                className="w-full bg-surface-container-lowest rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </select>
            </div>

            {/* Hours */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">Start Hour</label>
                <select
                  value={schedule.startHour}
                  onChange={(e) => updateSchedule({ startHour: e.target.value })}
                  className="w-full bg-surface-container-lowest rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                >
                  {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">End Hour</label>
                <select
                  value={schedule.endHour}
                  onChange={(e) => updateSchedule({ endHour: e.target.value })}
                  className="w-full bg-surface-container-lowest rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                >
                  {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            </div>

            {/* Days */}
            <div>
              <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-2">Active Days</label>
              <div className="flex gap-2">
                {DAY_LABELS.map((label, day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(day)}
                    className={`w-9 h-9 rounded-lg text-xs font-bold transition-all ${
                      schedule.days.includes(day)
                        ? 'primary-gradient text-on-primary ambient-shadow scale-105'
                        : 'bg-surface-container-lowest border border-slate-100 text-secondary hover:border-[#b0004a]/30'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Daily limit */}
            <div>
              <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">
                Daily Email Limit <span className="normal-case font-normal">(per account)</span>
              </label>
              <input
                type="number"
                min={5}
                max={500}
                value={schedule.dailyLimit}
                onChange={(e) => updateSchedule({ dailyLimit: Number(e.target.value) })}
                className="w-full bg-surface-container-lowest rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
              />
              <p className="text-xs text-secondary mt-1.5">
                Warmup guide: Week 1 → 20/day · Week 2 → 50/day · Week 3+ → 100+/day
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

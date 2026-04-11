'use client';

import { TIMEZONES, HOURS, DAY_LABELS, type SendingSchedule } from './scheduleConfig';

interface Props {
  name: string;
  schedule: SendingSchedule;
  onNameChange: (v: string) => void;
  onScheduleChange: (s: SendingSchedule) => void;
}

export default function WizardStep3Options({ name, schedule, onNameChange, onScheduleChange }: Props) {
  const set = <K extends keyof SendingSchedule>(key: K, value: SendingSchedule[K]) =>
    onScheduleChange({ ...schedule, [key]: value });

  const toggleDay = (d: number) => {
    const days = schedule.days.includes(d)
      ? schedule.days.filter((x) => x !== d)
      : [...schedule.days, d].sort();
    set('days', days);
  };

  const startIdx = HOURS.indexOf(schedule.startHour);
  const endIdx   = HOURS.indexOf(schedule.endHour);
  const hoursPerDay = endIdx > startIdx ? endIdx - startIdx : 0;
  const estimatedPerDay = Math.min(schedule.dailyLimit, hoursPerDay * 3);

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">

      {/* Headline */}
      <div className="text-center mb-10">
        <h1 className="text-3xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Campaign Options &amp; Schedule
        </h1>
        <p className="text-secondary text-sm">
          Name your campaign and configure the sending window so emails arrive at the right time.
        </p>
      </div>

      <div className="space-y-6">

        {/* Campaign Name */}
        <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100 bg-surface-container">
            <div className="w-7 h-7 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-on-primary text-[14px]">badge</span>
            </div>
            <div>
              <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Campaign Identity
              </p>
              <p className="text-xs text-secondary">Give your campaign a clear, searchable name</p>
            </div>
          </div>
          <div className="p-6">
            <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
              Campaign Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="e.g. UK Casino Outreach — April 2025"
              className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
            />
            <p className="text-xs text-secondary mt-2">
              Used for internal tracking only. Not visible to recipients.
            </p>
          </div>
        </div>

        {/* Sending Schedule */}
        <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100 bg-surface-container">
            <div className="w-7 h-7 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-on-primary text-[14px]">schedule</span>
            </div>
            <div>
              <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Sending Schedule
              </p>
              <p className="text-xs text-secondary">
                Emails will be paced within this window for best deliverability
              </p>
            </div>
          </div>

          <div className="p-6 grid grid-cols-2 gap-8">

            {/* Left column */}
            <div className="space-y-5">

              {/* Timezone */}
              <div>
                <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
                  Timezone
                </label>
                <select
                  value={schedule.timezone}
                  onChange={(e) => set('timezone', e.target.value)}
                  className="w-full bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </select>
              </div>

              {/* Time window */}
              <div>
                <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
                  Sending Window
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] text-secondary font-semibold mb-1">From</p>
                    <select
                      value={schedule.startHour}
                      onChange={(e) => set('startHour', e.target.value)}
                      className="w-full bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                    >
                      {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                  <div>
                    <p className="text-[10px] text-secondary font-semibold mb-1">Until</p>
                    <select
                      value={schedule.endHour}
                      onChange={(e) => set('endHour', e.target.value)}
                      className="w-full bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                    >
                      {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {/* Daily limit */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-extrabold text-secondary uppercase tracking-wider">
                    Daily Email Limit
                  </label>
                  <span className="text-sm font-extrabold text-[#b0004a]">{schedule.dailyLimit}</span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={300}
                  step={5}
                  value={schedule.dailyLimit}
                  onChange={(e) => set('dailyLimit', Number(e.target.value))}
                  className="w-full accent-[#b0004a] h-1.5"
                />
                <div className="flex justify-between text-[10px] text-secondary mt-1">
                  <span>5 / day</span>
                  <span>300 / day</span>
                </div>
                <p className="text-xs text-secondary mt-2">
                  Recommended: start at 50/day during warmup and increase gradually.
                </p>
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-5">

              {/* Active days */}
              <div>
                <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
                  Active Sending Days
                </label>
                <div className="flex gap-2 flex-wrap">
                  {DAY_LABELS.map((label, idx) => {
                    const active = schedule.days.includes(idx);
                    return (
                      <button
                        key={label}
                        onClick={() => toggleDay(idx)}
                        className={`w-10 h-10 rounded-xl text-xs font-extrabold transition-all ${
                          active
                            ? 'primary-gradient text-on-primary ambient-shadow'
                            : 'bg-surface-container text-secondary hover:bg-surface-container-high'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-secondary mt-2">
                  {schedule.days.length === 0
                    ? 'No days selected — campaign will not send'
                    : `Active on ${schedule.days.length} day${schedule.days.length !== 1 ? 's' : ''} per week`}
                </p>
              </div>

              {/* Schedule summary */}
              <div className="bg-surface-container rounded-xl p-4">
                <p className="text-xs font-extrabold text-on-surface uppercase tracking-wider mb-3">
                  Schedule Summary
                </p>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-secondary font-semibold">Timezone</span>
                    <span className="font-bold text-on-surface">
                      {TIMEZONES.find((t) => t.value === schedule.timezone)?.label.split('—')[0].trim() || schedule.timezone}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-secondary font-semibold">Window</span>
                    <span className="font-bold text-on-surface">{schedule.startHour} – {schedule.endHour}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-secondary font-semibold">Active days</span>
                    <span className="font-bold text-on-surface">
                      {schedule.days.map((d) => DAY_LABELS[d]).join(', ') || 'None'}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-secondary font-semibold">Daily cap</span>
                    <span className="font-bold text-[#b0004a]">{schedule.dailyLimit} emails</span>
                  </div>
                  <div className="pt-2 mt-2 border-t border-slate-100 flex justify-between text-xs">
                    <span className="text-secondary font-semibold">Est. per active day</span>
                    <span className="font-extrabold text-on-surface">{estimatedPerDay} emails</span>
                  </div>
                </div>
              </div>

              {/* Deliverability tip */}
              <div className="flex items-start gap-3 p-3 bg-[#ffd9de]/20 rounded-xl border border-[#b0004a]/10">
                <span className="material-symbols-outlined text-[#b0004a] text-[18px] flex-shrink-0 mt-0.5">tips_and_updates</span>
                <p className="text-[11px] text-secondary leading-relaxed">
                  <span className="font-bold text-on-surface">Deliverability tip:</span> Send between 8am–5pm in your recipient&apos;s timezone, Mon–Fri. Avoid weekends and early morning slots.
                </p>
              </div>

            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

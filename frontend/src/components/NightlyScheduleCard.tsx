'use client';

import { useState, useEffect } from 'react';
import { Play, Square, AlertTriangle } from 'lucide-react';
import { useSchedule, type ScheduleSettings, type SchedulePhase } from '../hooks/useSchedule';

const TIMEZONES = [
  'Asia/Manila', 'Asia/Singapore', 'Asia/Hong_Kong',
  'America/New_York', 'America/Los_Angeles',
  'Europe/London', 'Europe/Berlin', 'UTC',
];

const PHASE_LABEL: Record<SchedulePhase, string> = {
  disabled: 'Disabled',
  paused: 'Auto-paused',
  waiting_for_window: 'Waiting for window',
  inside_window_idle: 'Idle — no eligible combos',
  inside_window_running: 'Running',
  override_running: 'Run now active',
};

const PHASE_COLOR: Record<SchedulePhase, string> = {
  disabled: 'bg-surface-container text-secondary',
  paused: 'bg-red-100 text-red-800',
  waiting_for_window: 'bg-amber-100 text-amber-800',
  inside_window_idle: 'bg-blue-100 text-blue-800',
  inside_window_running: 'bg-[#ffd9de] text-[#b0004a]',
  override_running: 'bg-[#ffd9de] text-[#b0004a]',
};

export default function NightlyScheduleCard() {
  const { data, error, saving, saveSettings, runNow, stop, clearPause } = useSchedule();
  const [draft, setDraft] = useState<ScheduleSettings | null>(null);

  // Reset local draft when server data lands.
  useEffect(() => {
    if (data?.settings && !draft) setDraft(data.settings);
  }, [data?.settings, draft]);

  if (error) {
    return <div className="bg-red-50 text-red-800 rounded-xl p-4">Schedule API error: {error}</div>;
  }
  if (!data || !draft) {
    return <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6 text-secondary">Loading schedule…</div>;
  }

  const { settings, status, recentJobs } = data;
  const tickAgeSec = settings.nightly_scheduler_last_tick_at
    ? Math.round((Date.now() - new Date(settings.nightly_scheduler_last_tick_at).getTime()) / 1000)
    : null;
  const tickStale = tickAgeSec !== null && tickAgeSec > 120;

  const onToggle = async (next: boolean) => {
    await saveSettings({ nightly_scrape_enabled: next });
  };

  const onSaveDraft = async () => {
    await saveSettings({
      nightly_scrape_start_hour: draft.nightly_scrape_start_hour,
      nightly_scrape_end_hour: draft.nightly_scrape_end_hour,
      nightly_scrape_timezone: draft.nightly_scrape_timezone,
      nightly_scrape_rescrape_days: draft.nightly_scrape_rescrape_days,
      nightly_scrape_parallelism: draft.nightly_scrape_parallelism,
      nightly_scrape_verify: draft.nightly_scrape_verify,
      nightly_scrape_min_rating: draft.nightly_scrape_min_rating,
      nightly_scrape_max_rating: draft.nightly_scrape_max_rating,
    });
  };

  return (
    <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-4 sm:p-6 xl:p-8">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Nightly Schedule
        </h3>
        <span className={`flex items-center gap-2 text-xs font-bold px-3 py-1.5 rounded-full ${PHASE_COLOR[status.phase]}`}>
          {status.phase === 'inside_window_running' || status.phase === 'override_running' ? (
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse inline-block" />
          ) : null}
          {PHASE_LABEL[status.phase]}
          {status.phase === 'inside_window_running' || status.phase === 'override_running'
            ? ` ${status.inflight.length}/${status.matrixSize}`
            : ''}
        </span>
      </div>

      {settings.nightly_scheduler_paused_reason && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-red-800 flex-1">
            <div className="font-semibold">Scheduler auto-paused</div>
            <div className="text-xs opacity-90 mt-0.5">{settings.nightly_scheduler_paused_reason}</div>
          </div>
          <button onClick={clearPause} className="text-xs font-bold text-red-800 underline">Clear & resume</button>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.nightly_scrape_enabled}
            onChange={(e) => onToggle(e.target.checked)}
            disabled={saving || !!settings.nightly_scheduler_paused_reason}
          />
          <span className="font-bold">Enable nightly schedule</span>
        </label>
        <span className={`text-xs ${tickStale ? 'text-red-600' : 'text-secondary'}`}>
          Last tick: {tickAgeSec === null ? 'never' : `${tickAgeSec}s ago`}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4 text-sm">
        <label className="flex flex-col">
          <span className="text-xs text-secondary mb-1">Start hour</span>
          <input type="number" min={0} max={23} className="border rounded px-2 py-1"
            value={draft.nightly_scrape_start_hour}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_start_hour: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-secondary mb-1">End hour</span>
          <input type="number" min={0} max={23} className="border rounded px-2 py-1"
            value={draft.nightly_scrape_end_hour}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_end_hour: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-secondary mb-1">Timezone</span>
          <select className="border rounded px-2 py-1"
            value={draft.nightly_scrape_timezone}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_timezone: e.target.value })}>
            {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-secondary mb-1">Rescrape every (days)</span>
          <input type="number" min={1} max={90} className="border rounded px-2 py-1"
            value={draft.nightly_scrape_rescrape_days}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_rescrape_days: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-secondary mb-1">Parallelism</span>
          <input type="number" min={1} max={5} className="border rounded px-2 py-1"
            value={draft.nightly_scrape_parallelism}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_parallelism: Number(e.target.value) })} />
        </label>
        <label className="flex items-center gap-2 mt-5">
          <input type="checkbox"
            checked={draft.nightly_scrape_verify}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_verify: e.target.checked })} />
          <span>Verify emails</span>
        </label>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        <button onClick={onSaveDraft} disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-bold rounded">Save</button>
        <button onClick={runNow} disabled={saving}
          className="px-4 py-2 bg-[#b0004a] text-white text-sm font-bold rounded inline-flex items-center gap-1.5">
          <Play className="w-3.5 h-3.5" /> Run now (4h)
        </button>
        <button onClick={stop} disabled={saving}
          className="px-4 py-2 bg-surface-container text-on-surface text-sm font-bold rounded inline-flex items-center gap-1.5">
          <Square className="w-3.5 h-3.5" /> Stop in-flight
        </button>
      </div>

      <div className="border-t pt-4">
        <h4 className="text-sm font-bold mb-2 text-on-surface">Tonight's activity</h4>
        {recentJobs.length === 0 ? (
          <div className="text-xs text-secondary">No nightly runs yet.</div>
        ) : (
          <ul className="space-y-1 text-xs font-mono">
            {recentJobs.map((j) => (
              <li key={j.id} className="flex items-center gap-2">
                <span className={
                  j.status === 'completed' ? 'text-emerald-700'
                  : j.status === 'failed' ? 'text-red-700'
                  : j.status === 'running' ? 'text-blue-700' : 'text-secondary'
                }>
                  {j.status === 'completed' ? '✓' : j.status === 'failed' ? '✗' : j.status === 'running' ? '◷' : '·'}
                </span>
                <span>{j.category} · {j.country}</span>
                <span className="text-secondary">·</span>
                <span>{j.total_found ?? 0} leads</span>
                <span className="text-secondary">·</span>
                <span className="text-secondary">
                  {j.completed_at ? new Date(j.completed_at).toLocaleTimeString() : 'running'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

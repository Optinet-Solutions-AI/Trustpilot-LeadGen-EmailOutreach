'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/client';

export interface ScheduleSettings {
  nightly_scrape_enabled: boolean;
  nightly_scrape_start_hour: number;
  nightly_scrape_end_hour: number;
  nightly_scrape_timezone: string;
  nightly_scrape_rescrape_days: number;
  nightly_scrape_parallelism: number;
  nightly_scrape_verify: boolean;
  nightly_scrape_min_rating: number;
  nightly_scrape_max_rating: number;
  nightly_scheduler_last_tick_at: string | null;
  nightly_scheduler_paused_reason: string | null;
}

export interface InflightJob {
  id: string;
  country: string;
  category: string;
  status: string;
  started_at: string;
  total_found: number | null;
}

export interface RecentJob extends InflightJob {
  completed_at: string | null;
  total_failed: number | null;
}

export type SchedulePhase =
  | 'disabled' | 'paused' | 'waiting_for_window'
  | 'inside_window_idle' | 'inside_window_running' | 'override_running';

export interface ScheduleResponse {
  settings: ScheduleSettings;
  status: {
    phase: SchedulePhase;
    inflight: InflightJob[];
    runNowActive: boolean;
    matrixSize: number;
  };
  recentJobs: RecentJob[];
}

const POLL_INTERVAL_MS = 10_000;

export function useSchedule() {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);

  const fetchSchedule = useCallback(async () => {
    try {
      const { data: res } = await api.get('/scrape/schedule');
      if (mounted.current) setData(res.data);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    fetchSchedule();
    const iv = setInterval(fetchSchedule, POLL_INTERVAL_MS);
    return () => { mounted.current = false; clearInterval(iv); };
  }, [fetchSchedule]);

  const saveSettings = useCallback(async (patch: Partial<ScheduleSettings>) => {
    setSaving(true);
    try {
      const { data: res } = await api.patch('/scrape/schedule', patch);
      setData((prev) => prev ? { ...prev, settings: res.data.settings } : prev);
      await fetchSchedule();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [fetchSchedule]);

  const runNow = useCallback(async () => {
    await api.post('/scrape/schedule/run-now');
    await fetchSchedule();
  }, [fetchSchedule]);

  const stop = useCallback(async () => {
    await api.post('/scrape/schedule/stop');
    await fetchSchedule();
  }, [fetchSchedule]);

  const clearPause = useCallback(async () => {
    await saveSettings({ nightly_scheduler_paused_reason: null });
  }, [saveSettings]);

  return { data, error, saving, saveSettings, runNow, stop, clearPause, refresh: fetchSchedule };
}

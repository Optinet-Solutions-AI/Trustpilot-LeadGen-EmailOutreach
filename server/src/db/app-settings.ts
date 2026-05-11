import { getSupabase } from '../lib/supabase.js';

export interface AppSettings {
  id: 1;
  nightly_scrape_enabled: boolean;
  nightly_scrape_start_hour: number;     // 0-23
  nightly_scrape_end_hour: number;       // 0-23
  nightly_scrape_timezone: string;       // IANA tz
  nightly_scrape_rescrape_days: number;  // 1-90
  nightly_scrape_parallelism: number;    // 1-5
  nightly_scrape_verify: boolean;
  nightly_scrape_min_rating: number;
  nightly_scrape_max_rating: number;
  nightly_scheduler_last_tick_at: string | null;
  nightly_scheduler_paused_reason: string | null;
  updated_at: string;
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(v) ? v : lo)));

const clampReal = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

function clampSettings(raw: AppSettings): AppSettings {
  return {
    ...raw,
    nightly_scrape_start_hour: clampInt(raw.nightly_scrape_start_hour, 0, 23),
    nightly_scrape_end_hour: clampInt(raw.nightly_scrape_end_hour, 0, 23),
    nightly_scrape_rescrape_days: clampInt(raw.nightly_scrape_rescrape_days, 1, 90),
    nightly_scrape_parallelism: clampInt(raw.nightly_scrape_parallelism, 1, 5),
    nightly_scrape_min_rating: clampReal(raw.nightly_scrape_min_rating, 1.0, 5.0),
    nightly_scrape_max_rating: clampReal(raw.nightly_scrape_max_rating, 1.0, 5.0),
  };
}

export async function getSettings(): Promise<AppSettings> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data) {
    // Self-heal if the migration default row was deleted.
    const { data: inserted, error: insErr } = await supabase
      .from('app_settings')
      .insert({ id: 1 })
      .select('*')
      .single();
    if (insErr) throw new Error(insErr.message);
    return clampSettings(inserted as AppSettings);
  }

  return clampSettings(data as AppSettings);
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('app_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return clampSettings(data as AppSettings);
}

export async function writeSchedulerTick(): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from('app_settings')
    .update({ nightly_scheduler_last_tick_at: new Date().toISOString() })
    .eq('id', 1);
}

export async function setPausedReason(reason: string | null): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from('app_settings')
    .update({ nightly_scheduler_paused_reason: reason })
    .eq('id', 1);
}

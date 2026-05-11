import { Router, Request, Response } from 'express';
import { getSettings, updateSettings, type AppSettings } from '../db/app-settings.js';
import { setRunNowOverride, isRunNowActive } from '../services/nightly-scrape-scheduler.js';
import { cancelScrapeJob } from '../services/scrape-runner.js';
import { getSupabase } from '../lib/supabase.js';
import { COUNTRIES, CATEGORIES } from '../services/scrape-targets.js';

const router = Router();

// Settings fields the client is allowed to mutate via PATCH.
// Excludes server-managed fields (last_tick_at, paused_reason, updated_at).
const MUTABLE_FIELDS: Array<keyof AppSettings> = [
  'nightly_scrape_enabled',
  'nightly_scrape_start_hour',
  'nightly_scrape_end_hour',
  'nightly_scrape_timezone',
  'nightly_scrape_rescrape_days',
  'nightly_scrape_parallelism',
  'nightly_scrape_verify',
  'nightly_scrape_min_rating',
  'nightly_scrape_max_rating',
  'nightly_scheduler_paused_reason',  // allow client to clear the pause to null
];

router.get('/', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const settings = await getSettings();

    const { data: inflight } = await supabase
      .from('scrape_jobs')
      .select('id, country, category, status, started_at, total_found')
      .eq('source', 'nightly')
      .eq('status', 'running')
      .order('started_at', { ascending: true });

    const { data: recentJobs } = await supabase
      .from('scrape_jobs')
      .select('id, country, category, status, started_at, completed_at, total_found, total_failed')
      .eq('source', 'nightly')
      .order('created_at', { ascending: false })
      .limit(20);

    res.json({
      success: true,
      data: {
        settings,
        status: {
          phase: derivePhase(settings, inflight ?? []),
          inflight: inflight ?? [],
          runNowActive: isRunNowActive(),
          matrixSize: COUNTRIES.length * CATEGORIES.length,
        },
        recentJobs: recentJobs ?? [],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.patch('/', async (req: Request, res: Response) => {
  try {
    const patch: Partial<AppSettings> = {};
    for (const key of MUTABLE_FIELDS) {
      if (key in req.body) (patch as Record<string, unknown>)[key] = req.body[key];
    }
    const settings = await updateSettings(patch);
    res.json({ success: true, data: { settings } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/run-now', async (_req: Request, res: Response) => {
  try {
    const until = setRunNowOverride();
    res.json({ success: true, data: { runNowUntil: new Date(until).toISOString() } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/stop', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: inflight } = await supabase
      .from('scrape_jobs')
      .select('id')
      .eq('source', 'nightly')
      .eq('status', 'running');

    let cancelled = 0;
    for (const job of inflight ?? []) {
      try {
        await cancelScrapeJob(job.id);
        cancelled++;
      } catch {
        // best-effort: log and keep going. Orphan reaper will catch stragglers.
      }
    }
    await updateSettings({ nightly_scrape_enabled: false });
    res.json({ success: true, data: { cancelled } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

function derivePhase(
  s: AppSettings,
  inflight: Array<{ id: string }>,
): 'disabled' | 'paused' | 'waiting_for_window' | 'inside_window_idle' | 'inside_window_running' | 'override_running' {
  if (s.nightly_scheduler_paused_reason) return 'paused';
  if (isRunNowActive()) return inflight.length > 0 ? 'override_running' : 'inside_window_idle';
  if (!s.nightly_scrape_enabled) return 'disabled';

  const hour = (() => {
    try {
      return Number(new Intl.DateTimeFormat('en-US', {
        timeZone: s.nightly_scrape_timezone, hour: 'numeric', hour12: false,
      }).format(new Date()));
    } catch { return new Date().getUTCHours(); }
  })();

  const inWindow = s.nightly_scrape_start_hour === s.nightly_scrape_end_hour
    ? false
    : s.nightly_scrape_start_hour < s.nightly_scrape_end_hour
      ? hour >= s.nightly_scrape_start_hour && hour < s.nightly_scrape_end_hour
      : hour >= s.nightly_scrape_start_hour || hour < s.nightly_scrape_end_hour;

  if (!inWindow) return 'waiting_for_window';
  return inflight.length > 0 ? 'inside_window_running' : 'inside_window_idle';
}

export default router;

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';

/**
 * Seed inbox-placement tests. Kept in the private `seed-tests` Storage bucket
 * rather than a table — seeds are not leads and must never reach
 * campaign_leads, the sent-emails dedup set or the send counts.
 *
 *   <runId>/results.json     written only by scripts/seed-placement-send.ts
 *   <runId>/placements.json  written only here: { [ref]: {placement, placement_at} }
 *
 * Two objects so the script's per-send writes and a person's placement edit
 * never overwrite each other.
 */
const router = Router();
const BUCKET = 'seed-tests';
const PLACEMENTS = new Set(['unchecked', 'inbox', 'promotions', 'spam', 'not_found']);
const RUN_ID = /^[a-z0-9-]{4,64}$/i;

type PlacementMap = Record<string, { placement: string; placement_at: string }>;

async function readJson<T>(key: string): Promise<T | null> {
  const { data, error } = await getSupabase().storage.from(BUCKET).download(key);
  if (error || !data) return null;
  return JSON.parse(await data.text()) as T;
}

// GET /api/seed-tests/:runId
router.get('/:runId', async (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  if (!RUN_ID.test(runId)) { res.status(400).json({ success: false, error: 'Invalid run id' }); return; }
  try {
    const run = await readJson<{ subject?: string; updated_at?: string; results?: Array<Record<string, unknown>> }>(`${runId}/results.json`);
    const placements = (await readJson<PlacementMap>(`${runId}/placements.json`)) ?? {};
    const results = (run?.results ?? []).map((r) => {
      const p = placements[String(r.ref)];
      return { ...r, subject: run?.subject ?? null, placement: p?.placement ?? 'unchecked', placement_at: p?.placement_at ?? null };
    });
    res.json({ success: true, data: { runId, updated_at: run?.updated_at ?? null, results } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// PATCH /api/seed-tests/:runId/:ref  { placement }
router.patch('/:runId/:ref', async (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  const ref = String(req.params.ref);
  const placement = String(req.body?.placement ?? '');
  if (!RUN_ID.test(runId)) { res.status(400).json({ success: false, error: 'Invalid run id' }); return; }
  if (!PLACEMENTS.has(placement)) {
    res.status(400).json({ success: false, error: `placement must be one of ${[...PLACEMENTS].join(', ')}` });
    return;
  }
  try {
    const run = await readJson<{ results?: Array<{ ref: string }> }>(`${runId}/results.json`);
    if (!run?.results?.some((r) => r.ref === ref)) {
      res.status(404).json({ success: false, error: 'Seed not found in this run' });
      return;
    }
    const placements = (await readJson<PlacementMap>(`${runId}/placements.json`)) ?? {};
    placements[ref] = { placement, placement_at: new Date().toISOString() };
    const { error } = await getSupabase().storage.from(BUCKET).upload(
      `${runId}/placements.json`,
      new Blob([JSON.stringify(placements)], { type: 'application/json' }),
      { upsert: true, contentType: 'application/json', cacheControl: '0' },
    );
    if (error) throw error;
    res.json({ success: true, data: { ref, ...placements[ref] } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;

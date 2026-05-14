/**
 * Screenshot cleanup — sweeps the Supabase Storage `screenshots` bucket
 * for objects that are either:
 *
 *   (1) orphans — no lead or presence row references them
 *   (2) aged out — the parent lead hasn't been contacted in 90d and the
 *       screenshot itself is older than 180d
 *
 * The plan for migration 032 scoped storage hygiene to screenshots only;
 * `.tmp/`, scrape_jobs, lead_notes, etc. are intentionally not touched
 * here. Adding more retention later = add another sweep to this module.
 *
 * Authoritative `screenshot_path` lives in two columns today:
 *   - leads.screenshot_path             (legacy denormalized mirror)
 *   - lead_platform_presences.screenshot_path  (post-migration-032 home)
 * Both store full public URLs. We dedupe by filename when building the
 * reference set so a screenshot is never deleted as long as either column
 * still points at it.
 *
 * Audit trail: each run writes one row to cleanup_runs.
 */

import path from 'node:path';
import { getSupabase } from '../lib/supabase.js';

const BUCKET = 'screenshots';
const AGE_SCREENSHOT_DAYS = 180; // age threshold for the screenshot itself
const AGE_CONTACTED_DAYS = 90;   // age threshold for "untouched lead"

interface CleanupSummary {
  orphans_deleted: number;
  aged_deleted: number;
  errors: { phase: string; message: string }[];
  duration_ms: number;
}

/**
 * Strip everything but the bare filename from a screenshot path. Handles
 * both full public URLs and bare filenames (older rows). Returns null if
 * the input isn't a plausible screenshot reference.
 */
function filenameOf(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;
  // path.posix.basename handles both forward-slash URLs and bare names.
  const base = path.posix.basename(rawPath.split('?')[0].split('#')[0]);
  if (!base) return null;
  return base;
}

/**
 * Paginate the bucket listing — supabase-js .list() caps each call at 100
 * objects. Burning through 6k files takes ~60 round-trips; not great but
 * happens once a day off-peak.
 */
async function listAllScreenshotObjects(): Promise<{ name: string }[]> {
  const supabase = getSupabase();
  const all: { name: string }[] = [];
  const PAGE = 100;
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .storage
      .from(BUCKET)
      .list('', { limit: PAGE, offset });
    if (error) throw new Error(`list ${BUCKET}: ${error.message}`);
    const batch = (data ?? []).filter((o) => o.name && !o.name.endsWith('/'));
    all.push(...batch.map((o) => ({ name: o.name })));
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

/**
 * Build the set of screenshot filenames still referenced from the DB.
 * Used for the orphan sweep. We pull from both leads (legacy mirror) and
 * lead_platform_presences (new home) and dedupe by basename so we never
 * delete a file that ANY column still points at.
 */
async function collectReferencedFilenames(): Promise<Set<string>> {
  const supabase = getSupabase();
  const referenced = new Set<string>();
  const PAGE = 1000;

  // leads.screenshot_path
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('leads')
      .select('screenshot_path')
      .not('screenshot_path', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`list leads.screenshot_path: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const f = filenameOf(r.screenshot_path as string | null);
      if (f) referenced.add(f);
    }
    if (data.length < PAGE) break;
  }

  // lead_platform_presences.screenshot_path
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('lead_platform_presences')
      .select('screenshot_path')
      .not('screenshot_path', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`list presences.screenshot_path: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const f = filenameOf(r.screenshot_path as string | null);
      if (f) referenced.add(f);
    }
    if (data.length < PAGE) break;
  }

  return referenced;
}

/**
 * Batch delete from the bucket. supabase-js .remove() accepts an array of
 * paths in one call but we chunk to be defensive about request size.
 */
async function deleteBucketObjects(filenames: string[]): Promise<number> {
  if (filenames.length === 0) return 0;
  const supabase = getSupabase();
  const CHUNK = 100;
  let deleted = 0;
  for (let i = 0; i < filenames.length; i += CHUNK) {
    const chunk = filenames.slice(i, i + CHUNK);
    const { data, error } = await supabase.storage.from(BUCKET).remove(chunk);
    if (error) throw new Error(`remove batch (${chunk.length}): ${error.message}`);
    deleted += data?.length ?? 0;
  }
  return deleted;
}

/**
 * Age sweep — find presences whose screenshot is older than the threshold
 * AND whose parent lead is cold (no contacted_at, or contacted_at older
 * than 90d). Delete the bucket object, then null both DB references.
 */
async function ageSweep(errors: CleanupSummary['errors']): Promise<number> {
  const supabase = getSupabase();
  const screenshotCutoff = new Date(Date.now() - AGE_SCREENSHOT_DAYS * 86_400_000).toISOString();
  const contactedCutoff = new Date(Date.now() - AGE_CONTACTED_DAYS * 86_400_000).toISOString();

  // Pull candidate presences with the parent lead's contacted_at embedded.
  // The !inner join restricts to rows whose parent lead matches the cold
  // criteria; we further filter contacted_at in JS because PostgREST can't
  // express "IS NULL OR <cutoff" on an embedded field in a single .or().
  const { data, error } = await supabase
    .from('lead_platform_presences')
    .select('id, lead_id, screenshot_path, scraped_at, leads!inner(id, contacted_at)')
    .not('screenshot_path', 'is', null)
    .lt('scraped_at', screenshotCutoff);
  if (error) {
    errors.push({ phase: 'age_sweep_query', message: error.message });
    return 0;
  }

  type Row = {
    id: string;
    lead_id: string;
    screenshot_path: string;
    scraped_at: string;
    leads: { id: string; contacted_at: string | null } | { id: string; contacted_at: string | null }[];
  };
  const rows = (data ?? []) as unknown as Row[];

  const toDelete: { presenceId: string; leadId: string; filename: string }[] = [];
  for (const r of rows) {
    const lead = Array.isArray(r.leads) ? r.leads[0] : r.leads;
    if (!lead) continue;
    const cold = !lead.contacted_at || lead.contacted_at < contactedCutoff;
    if (!cold) continue;
    const fname = filenameOf(r.screenshot_path);
    if (!fname) continue;
    toDelete.push({ presenceId: r.id, leadId: r.lead_id, filename: fname });
  }

  if (toDelete.length === 0) return 0;

  // 1) Delete bucket objects (best-effort — DB cleanup proceeds even if
  //    some objects fail to remove).
  try {
    await deleteBucketObjects(toDelete.map((d) => d.filename));
  } catch (e) {
    errors.push({ phase: 'age_sweep_remove', message: e instanceof Error ? e.message : String(e) });
  }

  // 2) Null screenshot_path on the matching presence rows.
  const presenceIds = toDelete.map((d) => d.presenceId);
  for (let i = 0; i < presenceIds.length; i += 100) {
    const ids = presenceIds.slice(i, i + 100);
    const { error: pErr } = await supabase
      .from('lead_platform_presences')
      .update({ screenshot_path: null })
      .in('id', ids);
    if (pErr) errors.push({ phase: 'age_sweep_null_presence', message: pErr.message });
  }

  // 3) Null leads.screenshot_path on the matching parent leads so the
  //    legacy mirror column doesn't keep pointing at a dead URL.
  const leadIds = Array.from(new Set(toDelete.map((d) => d.leadId)));
  for (let i = 0; i < leadIds.length; i += 100) {
    const ids = leadIds.slice(i, i + 100);
    const { error: lErr } = await supabase
      .from('leads')
      .update({ screenshot_path: null })
      .in('id', ids);
    if (lErr) errors.push({ phase: 'age_sweep_null_lead', message: lErr.message });
  }

  return toDelete.length;
}

/**
 * Main entrypoint. Wrap in try/catch at the route layer — errors here
 * surface in the cleanup_runs row.errors jsonb so the operator can spot
 * recurring failures without scraping Cloud Run logs.
 */
export async function runScreenshotCleanup(): Promise<CleanupSummary> {
  const supabase = getSupabase();
  const t0 = Date.now();
  const errors: CleanupSummary['errors'] = [];

  // ── 1. Age sweep first ────────────────────────────────────────────
  // We do the age sweep BEFORE collecting referenced filenames so any
  // objects newly nulled out get caught by the orphan sweep on the same
  // run. Otherwise we'd take two days to fully drop a cold screenshot.
  let aged_deleted = 0;
  try {
    aged_deleted = await ageSweep(errors);
  } catch (e) {
    errors.push({ phase: 'age_sweep', message: e instanceof Error ? e.message : String(e) });
  }

  // ── 2. Orphan sweep ──────────────────────────────────────────────
  let orphans_deleted = 0;
  try {
    const [bucketObjects, referenced] = await Promise.all([
      listAllScreenshotObjects(),
      collectReferencedFilenames(),
    ]);
    const orphans = bucketObjects
      .map((o) => o.name)
      .filter((name) => !referenced.has(name));
    if (orphans.length > 0) {
      orphans_deleted = await deleteBucketObjects(orphans);
    }
  } catch (e) {
    errors.push({ phase: 'orphan_sweep', message: e instanceof Error ? e.message : String(e) });
  }

  const duration_ms = Date.now() - t0;

  // ── 3. Audit row ─────────────────────────────────────────────────
  await supabase.from('cleanup_runs').insert({
    orphans_deleted,
    aged_deleted,
    errors: errors.length > 0 ? errors : null,
    duration_ms,
  }).then((r) => {
    if (r.error) console.warn(`[ScreenshotCleanup] audit insert failed: ${r.error.message}`);
  });

  return { orphans_deleted, aged_deleted, errors, duration_ms };
}

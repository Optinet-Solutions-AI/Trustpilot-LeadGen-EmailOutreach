import { getSupabase } from '../lib/supabase.js';

export interface ScrapeJob {
  id: string;
  country: string;
  category: string;
  min_rating: number;
  max_rating: number;
  enrich: boolean;
  verify: boolean;
  status: 'pending' | 'running' | 'completed' | 'failed';
  source: 'manual' | 'nightly';
  worker_id: string | null;
  claimed_at: string | null;
  last_heartbeat_at: string | null;
  attempts: number;
  max_attempts: number;
  priority: number;
  total_found: number;
  total_scraped: number;
  total_enriched: number;
  total_verified: number;
  error: string | null;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export async function createJob(params: {
  country: string;
  category: string;
  min_rating: number;
  max_rating: number;
  enrich: boolean;
  verify: boolean;
  source?: 'manual' | 'nightly';
}) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_jobs')
    .insert({ ...params, source: params.source ?? 'manual' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Queue API — used by both the API (enqueue) and the remote EC2 worker
 * (claim / heartbeat / complete / fail). The atomic claim and stale-claim
 * sweep are implemented as Postgres RPCs in migration 030 because
 * supabase-js can't express FOR UPDATE SKIP LOCKED directly.
 */

export async function enqueueJob(params: {
  country: string;
  category: string;
  min_rating: number;
  max_rating: number;
  enrich: boolean;
  verify: boolean;
  source?: 'manual' | 'nightly';
  priority?: number;
  max_attempts?: number;
}): Promise<ScrapeJob> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_jobs')
    .insert({
      country: params.country,
      category: params.category,
      min_rating: params.min_rating,
      max_rating: params.max_rating,
      enrich: params.enrich,
      verify: params.verify,
      source: params.source ?? 'manual',
      status: 'pending',
      priority: params.priority ?? (params.source === 'nightly' ? 100 : 10),
      max_attempts: params.max_attempts ?? 3,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as ScrapeJob;
}

export async function claimNextPendingJob(
  workerId: string,
  maxConcurrent = 3,
): Promise<ScrapeJob | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('claim_next_pending_scrape_job', {
    p_worker_id: workerId,
    p_max_concurrent: maxConcurrent,
  });
  if (error) throw new Error(error.message);
  // RPC declares RETURNS SETOF scrape_jobs so data is an array. Empty array
  // means nothing to claim. We also defensively handle the legacy composite
  // shape — supabase-js used to unwrap a NULL composite into {id: null, ...}
  // and we want a row-of-nulls to map to "no claim", not a fake job with id=null.
  if (!data) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || (row as { id: unknown }).id == null) return null;
  return row as ScrapeJob;
}

export async function heartbeat(jobId: string, workerId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('scrape_jobs')
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('worker_id', workerId);  // only the owner can heartbeat
  if (error) throw new Error(error.message);
}

export async function markJobComplete(
  jobId: string,
  stats: { total_found?: number; total_scraped?: number; total_enriched?: number; total_verified?: number },
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('scrape_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      total_found: stats.total_found ?? 0,
      total_scraped: stats.total_scraped ?? 0,
      total_enriched: stats.total_enriched ?? 0,
      total_verified: stats.total_verified ?? 0,
    })
    .eq('id', jobId);
  if (error) throw new Error(error.message);
}

/**
 * Mark a job failed. If it still has retry budget (attempts < max_attempts)
 * it goes back to 'pending' so another claim can pick it up; otherwise it
 * lands in 'failed' permanently.
 */
export async function markJobFailed(jobId: string, errorMessage: string): Promise<void> {
  const supabase = getSupabase();
  const { data: row, error: readErr } = await supabase
    .from('scrape_jobs')
    .select('attempts, max_attempts')
    .eq('id', jobId)
    .single();
  if (readErr) throw new Error(readErr.message);

  const retryable = (row?.attempts ?? 0) < (row?.max_attempts ?? 3);
  const patch: Record<string, unknown> = retryable
    ? {
        status: 'pending',
        worker_id: null,
        claimed_at: null,
        last_error: errorMessage.slice(0, 2000),
      }
    : {
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: errorMessage.slice(0, 2000),
        last_error: errorMessage.slice(0, 2000),
      };

  const { error } = await supabase.from('scrape_jobs').update(patch).eq('id', jobId);
  if (error) throw new Error(error.message);
}

/**
 * Sweep stale claims. Called every 5 min by the Cloud Run scheduler tick.
 * Returns the count of rows that were either re-queued or permanently failed.
 */
export async function releaseStaleClaims(maxAgeMin = 10): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('release_stale_scrape_claims', {
    p_max_age_min: maxAgeMin,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

export async function updateJob(id: string, patch: Record<string, unknown>) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_jobs')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function getJob(id: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Returns a currently running job for the same country+category, or null. */
export async function findActiveJobForParams(country: string, category: string) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('scrape_jobs')
    .select('id, status, created_at, total_found')
    .eq('country', country)
    .eq('category', category)
    .eq('status', 'running')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as { id: string; status: string; created_at: string; total_found: number } | null;
}

/**
 * Check for any OTHER running job with the same country+category created
 * before or concurrently with `selfJobId`. Used right after insert to
 * resolve races where multiple POSTs all passed the pre-insert dedup check
 * and created sibling jobs. The oldest one wins; newer ones are deleted.
 * Returns the winning job id (may be selfJobId if it's the oldest).
 */
export async function resolveDuplicateActiveJob(
  selfJobId: string,
  country: string,
  category: string,
): Promise<string> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('scrape_jobs')
    .select('id, created_at')
    .eq('country', country)
    .eq('category', category)
    .eq('status', 'running')
    .order('created_at', { ascending: true });
  const all = (data as Array<{ id: string; created_at: string }>) ?? [];
  if (all.length <= 1) return selfJobId;
  const winner = all[0].id;
  if (winner === selfJobId) return selfJobId;
  // We lost the race — delete our just-inserted row so the UI doesn't show
  // two simultaneous "running" rows for the same country+category.
  await supabase.from('scrape_jobs').delete().eq('id', selfJobId);
  return winner;
}

export async function getJobs() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('*')
    .neq('country', '_enrich_')  // exclude enrichment-only jobs (managed by /api/enrich)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function deleteJob(id: string) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('scrape_jobs')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Deletes every non-running scrape job whose (country, category) combination
 * has zero leads in the leads table — i.e. the job looks completed in the
 * Recent Jobs list but produced nothing that appears in the Lead Matrix.
 * Returns the list of deleted job rows.
 */
export async function deleteEmptyJobs() {
  const supabase = getSupabase();

  const { data: jobs, error: jobsErr } = await supabase
    .from('scrape_jobs')
    .select('id, country, category, status')
    .neq('country', '_enrich_')
    .neq('status', 'running');
  if (jobsErr) throw new Error(jobsErr.message);

  const candidates = jobs || [];
  if (candidates.length === 0) return [];

  // Unique (country, category) pairs → single count query each
  const pairs = new Map<string, { country: string; category: string }>();
  for (const j of candidates) {
    pairs.set(`${j.country}::${j.category}`, { country: j.country, category: j.category });
  }

  const emptyPairs = new Set<string>();
  for (const [key, { country, category }] of pairs) {
    const { count, error } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('country', country)
      .eq('category', category);
    if (error) throw new Error(error.message);
    if ((count ?? 0) === 0) emptyPairs.add(key);
  }

  const toDelete = candidates.filter(j => emptyPairs.has(`${j.country}::${j.category}`));
  if (toDelete.length === 0) return [];

  const { error: delErr } = await supabase
    .from('scrape_jobs')
    .delete()
    .in('id', toDelete.map(j => j.id));
  if (delErr) throw new Error(delErr.message);

  return toDelete;
}

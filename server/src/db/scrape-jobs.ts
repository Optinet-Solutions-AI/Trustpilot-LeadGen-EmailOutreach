import { getSupabase } from '../lib/supabase.js';

export async function createJob(params: {
  country: string;
  category: string;
  min_rating: number;
  max_rating: number;
  enrich: boolean;
  verify: boolean;
}) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_jobs')
    .insert(params)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
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

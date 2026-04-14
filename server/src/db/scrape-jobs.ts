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

/** Returns the most recent completed or running job for the same country+category, or null. */
export async function findActiveJobForParams(country: string, category: string) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('scrape_jobs')
    .select('id, status, created_at, total_found')
    .eq('country', country)
    .eq('category', category)
    .in('status', ['running', 'completed'])
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

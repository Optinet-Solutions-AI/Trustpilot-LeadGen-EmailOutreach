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

export async function getJobs() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return data || [];
}

import { getSupabase } from '../lib/supabase.js';

export async function insertFailure(params: {
  job_id: string;
  url: string;
  stage: string;
  error_message: string;
}) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('scrape_failures')
    .insert(params);
  if (error) console.error('Failed to insert scrape failure:', error.message);
}

export async function getFailuresByJob(jobId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_failures')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getUnresolvedFailures(jobId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_failures')
    .select('*')
    .eq('job_id', jobId)
    .eq('resolved', false);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function markResolved(failureIds: string[]) {
  if (failureIds.length === 0) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from('scrape_failures')
    .update({ resolved: true })
    .in('id', failureIds);
  if (error) throw new Error(error.message);
}

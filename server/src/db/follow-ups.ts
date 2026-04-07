import { getSupabase } from '../lib/supabase.js';

export async function getFollowUps(options: { leadId?: string; upcoming?: boolean } = {}) {
  const supabase = getSupabase();
  let query = supabase.from('follow_ups').select('*, leads(company_name, outreach_status)');

  if (options.leadId) query = query.eq('lead_id', options.leadId);
  if (options.upcoming) query = query.eq('completed', false).gte('due_date', new Date().toISOString());

  const { data, error } = await query.order('due_date', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createFollowUp(followUp: {
  lead_id: string;
  due_date: string;
  note?: string;
}) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('follow_ups')
    .insert(followUp)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function completeFollowUp(id: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('follow_ups')
    .update({ completed: true, completed_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

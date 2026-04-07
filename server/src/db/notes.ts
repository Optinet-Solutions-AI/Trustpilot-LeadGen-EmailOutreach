import { getSupabase } from '../lib/supabase.js';

export async function getNotes(leadId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('lead_notes')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createNote(leadId: string, note: {
  type: string;
  content?: string;
  metadata?: Record<string, unknown>;
}) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('lead_notes')
    .insert({ lead_id: leadId, ...note })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

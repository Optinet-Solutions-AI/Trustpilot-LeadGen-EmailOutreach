import { getSupabase } from '../lib/supabase.js';

export async function getCampaigns() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createCampaign(campaign: {
  name: string;
  template_subject: string;
  template_body: string;
  include_screenshot?: boolean;
}) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('campaigns').insert(campaign).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateCampaign(id: string, patch: Record<string, unknown>) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('campaigns').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function addLeadsToCampaign(campaignId: string, leadIds: string[]) {
  const supabase = getSupabase();
  // First get the emails for each lead
  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id, primary_email')
    .in('id', leadIds);
  if (leadsError) throw new Error(leadsError.message);

  const rows = (leads || []).map((lead) => ({
    campaign_id: campaignId,
    lead_id: lead.id,
    email_used: lead.primary_email,
    status: 'pending',
  }));

  const { data, error } = await supabase.from('campaign_leads').upsert(rows, {
    onConflict: 'campaign_id,lead_id',
  }).select();
  if (error) throw new Error(error.message);
  return data;
}

export async function getCampaignLeads(campaignId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('*, leads(*)')
    .eq('campaign_id', campaignId);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addLeadsByFilter(campaignId: string, filters: { country?: string; category?: string }) {
  const supabase = getSupabase();

  let query = supabase
    .from('leads')
    .select('id, primary_email')
    .not('primary_email', 'is', null);

  if (filters.country) query = query.eq('country', filters.country);
  if (filters.category) query = query.eq('category', filters.category);

  const { data: leads, error: leadsError } = await query;
  if (leadsError) throw new Error(leadsError.message);
  if (!leads || leads.length === 0) return [];

  const rows = leads.map((lead) => ({
    campaign_id: campaignId,
    lead_id: lead.id,
    email_used: lead.primary_email,
    status: 'pending',
  }));

  const { data, error } = await supabase.from('campaign_leads').upsert(rows, {
    onConflict: 'campaign_id,lead_id',
  }).select();
  if (error) throw new Error(error.message);
  return data;
}

export async function getCampaignStats(campaignId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('status')
    .eq('campaign_id', campaignId);
  if (error) throw new Error(error.message);

  const stats = { pending: 0, sent: 0, opened: 0, replied: 0, bounced: 0 };
  for (const row of data || []) {
    const s = row.status as keyof typeof stats;
    if (s in stats) stats[s]++;
  }
  return stats;
}

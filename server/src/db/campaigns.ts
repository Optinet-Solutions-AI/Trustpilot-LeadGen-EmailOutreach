import { getSupabase } from '../lib/supabase.js';

export async function getCampaigns() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('campaigns')
    .select('*, campaign_leads(count)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  // Flatten the nested count into a simple lead_count field
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data || []).map((c: any) => ({
    ...c,
    lead_count: c.campaign_leads?.[0]?.count ?? 0,
    campaign_leads: undefined,
  }));
}

export async function createCampaign(campaign: {
  name: string;
  template_subject: string;
  template_body: string;
  include_screenshot?: boolean;
  filter_country?: string;
  filter_category?: string;
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

export async function deleteCampaign(id: string) {
  const supabase = getSupabase();
  // campaign_leads are cascade-deleted by DB FK constraint
  const { error } = await supabase.from('campaigns').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** Returns a Set of email addresses already successfully sent in any campaign. */
export async function getSentEmails(): Promise<Set<string>> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('email_used')
    .in('status', ['sent', 'opened', 'replied']);
  if (error) throw new Error(error.message);
  return new Set(
    (data || []).map((r: { email_used: string | null }) => r.email_used).filter(Boolean) as string[]
  );
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

export async function updateCampaignLeadGmailIds(
  campaignLeadId: string,
  gmailMessageId?: string,
  gmailThreadId?: string
) {
  const supabase = getSupabase();
  const patch: Record<string, string> = {};
  if (gmailMessageId) patch.gmail_message_id = gmailMessageId;
  if (gmailThreadId) patch.gmail_thread_id = gmailThreadId;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from('campaign_leads').update(patch).eq('id', campaignLeadId);
  if (error) console.warn('[DB] Failed to update gmail IDs:', error.message);
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

export async function duplicateCampaign(sourceId: string) {
  const supabase = getSupabase();

  // Fetch the source campaign
  const { data: source, error: fetchErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', sourceId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!source) throw new Error('Campaign not found');

  // Create a copy as draft
  const newCampaign = await createCampaign({
    name: `${source.name} (copy)`,
    template_subject: source.template_subject,
    template_body: source.template_body,
    include_screenshot: source.include_screenshot,
    filter_country: source.filter_country || undefined,
    filter_category: source.filter_category || undefined,
  });

  // Re-populate leads using the same filters
  await addLeadsByFilter(newCampaign.id, {
    country: source.filter_country || undefined,
    category: source.filter_category || undefined,
  });

  return newCampaign;
}

export async function previewRecipientCount(filters: { country?: string; category?: string }) {
  const supabase = getSupabase();

  let query = supabase
    .from('leads')
    .select('id, company_name, primary_email, star_rating', { count: 'exact' })
    .not('primary_email', 'is', null);

  if (filters.country) query = query.eq('country', filters.country);
  if (filters.category) query = query.eq('category', filters.category);

  const { data, count, error } = await query.limit(10);
  if (error) throw new Error(error.message);

  return {
    count: count ?? 0,
    sample: data || [],
  };
}

import { getSupabase } from '../lib/supabase.js';

export async function getCampaigns() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('campaigns')
    .select('*, campaign_leads(count), campaign_steps(count)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const campaigns = (data || []).map((c: any) => ({
    ...c,
    lead_count: c.campaign_leads?.[0]?.count ?? 0,
    step_count: c.campaign_steps?.[0]?.count ?? 0,
    campaign_leads: undefined,
    campaign_steps: undefined,
  }));

  if (campaigns.length === 0) return campaigns;

  // Compute live stats from campaign_leads so the card always shows accurate
  // sent/replied/bounced counts regardless of whether total_* columns were updated.
  const { data: clRows } = await supabase
    .from('campaign_leads')
    .select('campaign_id, status')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .in('campaign_id', campaigns.map((c: any) => c.id));

  const stats: Record<string, { total_sent: number; total_replied: number; total_bounced: number; total_opened: number }> = {};
  for (const row of clRows || []) {
    if (!stats[row.campaign_id]) {
      stats[row.campaign_id] = { total_sent: 0, total_replied: 0, total_bounced: 0, total_opened: 0 };
    }
    const s = row.status as string;
    if (s === 'sent' || s === 'opened' || s === 'replied') stats[row.campaign_id].total_sent++;
    if (s === 'replied') stats[row.campaign_id].total_replied++;
    if (s === 'bounced')  stats[row.campaign_id].total_bounced++;
    if (s === 'opened')  stats[row.campaign_id].total_opened++;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return campaigns.map((c: any) => ({
    ...c,
    total_sent:    stats[c.id]?.total_sent    ?? c.total_sent    ?? 0,
    total_replied: stats[c.id]?.total_replied ?? c.total_replied ?? 0,
    total_bounced: stats[c.id]?.total_bounced ?? c.total_bounced ?? 0,
    total_opened:  stats[c.id]?.total_opened  ?? c.total_opened  ?? 0,
  }));
}

export async function createCampaign(campaign: {
  name: string;
  template_subject: string;
  template_body: string;
  include_screenshot?: boolean;
  filter_country?: string;
  filter_category?: string;
  sending_schedule?: Record<string, unknown> | null;
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

/**
 * Returns a Set of email addresses that should NOT receive another campaign email.
 * Includes: previously sent/opened/replied (already contacted) + bounced (permanently failed).
 * This prevents re-sending to hard-bounced addresses and double-emailing active conversations.
 */
export async function getSentEmails(): Promise<Set<string>> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('email_used')
    .in('status', ['sent', 'opened', 'replied', 'bounced']);
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
    sending_schedule: source.sending_schedule || undefined,
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

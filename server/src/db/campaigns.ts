import { getSupabase } from '../lib/supabase.js';
import { resolvePrimaryEmail } from '../services/email/resolve-primary-email.js';
import { categoryFamily } from '../services/lead-categories.js';

/** Apply the recipient category filter, FAMILY-aware.
 *
 *  Each scraping platform writes its own taxonomy for the same trade —
 *  Facebook stores the operator's typed niche ("plumber"), Yelp its slug
 *  ("plumbers"), others "plumbing". Exact equality here silently halved
 *  campaign audiences: a campaign for "electrician" matched 80 leads and
 *  dropped the 78 spelled "electricians".
 *
 *  Shared by addLeadsByFilter and previewRecipientCount so the number the
 *  operator is SHOWN can never diverge from the audience actually emailed.
 *  Source of truth for the families is tools/db/category_canonical.py, which
 *  the TS mirror is drift-guarded against.
 *
 *  DELIBERATELY EXACT, not substring. The Lead Matrix uses categoryOrFilter,
 *  which builds `ilike.%needle%` — fine for browsing, where partial typing is
 *  wanted. On THIS path substring matching silently widens the audience: it
 *  made `casino` also select `online_casino_or_bookmaker`, adding ~98 people
 *  to a cold-email send who were previously excluded. Growing a send list is
 *  not something a de-fragmentation fix should do as a side effect, so we
 *  match the family members exactly. `casino`, deliberately unmerged, has a
 *  family of just itself and so still selects only itself.
 */
function applyRecipientFilters<T>(query: T, filters: { country?: string; category?: string }): T {
  let q = query as any;
  if (filters.country) q = q.eq('country', filters.country);
  if (filters.category) {
    const family = categoryFamily(filters.category);
    if (family.length > 1) q = q.in('category', family);
    else q = q.eq('category', family[0] ?? filters.category);
  }
  return q as T;
}

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

  const stats: Record<string, { total_sent: number; total_replied: number; total_auto_replied: number; total_bounced: number; total_opened: number }> = {};
  for (const row of clRows || []) {
    if (!stats[row.campaign_id]) {
      stats[row.campaign_id] = { total_sent: 0, total_replied: 0, total_auto_replied: 0, total_bounced: 0, total_opened: 0 };
    }
    const s = row.status as string;
    // 'auto_replied' is a terminal status that started life as 'sent' before
    // the auto-reply landed — count it toward total_sent so the campaign's
    // delivery total stays accurate, but track total_replied separately so
    // reply-rate metrics reflect human engagement only.
    if (s === 'sent' || s === 'opened' || s === 'replied' || s === 'auto_replied') stats[row.campaign_id].total_sent++;
    if (s === 'replied')      stats[row.campaign_id].total_replied++;
    if (s === 'auto_replied') stats[row.campaign_id].total_auto_replied++;
    if (s === 'bounced')      stats[row.campaign_id].total_bounced++;
    if (s === 'opened')       stats[row.campaign_id].total_opened++;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return campaigns.map((c: any) => ({
    ...c,
    total_sent:         stats[c.id]?.total_sent         ?? c.total_sent         ?? 0,
    total_replied:      stats[c.id]?.total_replied      ?? c.total_replied      ?? 0,
    total_auto_replied: stats[c.id]?.total_auto_replied ?? c.total_auto_replied ?? 0,
    total_bounced:      stats[c.id]?.total_bounced      ?? c.total_bounced      ?? 0,
    total_opened:       stats[c.id]?.total_opened       ?? c.total_opened       ?? 0,
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
  // Optional. 'outreach' (default) sends to lead.primary_email like every
  // existing campaign. 'discovery_followup' targets lead.discovered_email
  // and is launched from the Prospects → Accepted tab.
  campaign_type?: 'outreach' | 'discovery_followup';
  parent_campaign_id?: string;
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
 * Includes: previously sent/opened/replied/auto_replied (already contacted) +
 * bounced (permanently failed). auto_replied is in here because the original
 * support inbox is unmonitored — re-emailing it just produces another
 * auto-reply. This prevents re-sending to hard-bounced addresses and
 * double-emailing active conversations.
 *
 * All entries are lowercased so callers can do case-insensitive lookups
 * without worrying about how the address was capitalised at scrape/insert time.
 */
export async function getSentEmails(): Promise<Set<string>> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('email_used')
    .in('status', ['sent', 'opened', 'replied', 'auto_replied', 'bounced']);
  if (error) throw new Error(error.message);
  const out = new Set<string>();
  for (const r of (data || []) as Array<{ email_used: string | null }>) {
    if (r.email_used) out.add(r.email_used.toLowerCase());
  }
  return out;
}

/**
 * Flip the given campaign_leads rows to status='skipped' and record why.
 * Used by the send route's dedup step and by addLeadsToCampaign so the UI
 * pill matches reality instead of guessing from a stuck 'pending' state.
 */
export async function markCampaignLeadsSkipped(
  campaignLeadIds: string[],
  reason: 'already_contacted_in_another_campaign',
): Promise<void> {
  if (campaignLeadIds.length === 0) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from('campaign_leads')
    .update({ status: 'skipped', skip_reason: reason })
    .in('id', campaignLeadIds);
  if (error) throw new Error(error.message);
}

export async function addLeadsToCampaign(campaignId: string, leadIds: string[]) {
  const supabase = getSupabase();

  // Look up the campaign type so discovery_followup campaigns can target
  // lead.discovered_email instead of the resolver's primary pick. Outreach
  // campaigns (the default) keep the unchanged primary_email path.
  const { data: campaignRow } = await supabase
    .from('campaigns')
    .select('campaign_type')
    .eq('id', campaignId)
    .single();
  const isDiscoveryFollowup = campaignRow?.campaign_type === 'discovery_followup';

  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id, primary_email, trustpilot_email, website_email, discovered_email, affiliate_email, trustpilot_email_status, website_email_status, discovered_email_status, affiliate_email_status, verification_status')
    .in('id', leadIds)
    // Never add Trustpilot-flagged (blocked) leads to a campaign, even if the
    // caller hands their IDs in explicitly (migration 048).
    .eq('blocked', false)
    // Never re-contact a lead that opted out / asked to be removed (migration 050).
    .eq('do_not_contact', false);
  if (leadsError) throw new Error(leadsError.message);

  // Pre-fetch the global "already contacted" set so anything that came
  // through the picker despite the badge (manual click-through, legacy
  // selection, race with another campaign send) lands as 'skipped' instead
  // of 'pending'. The send-time filter still runs as a safety net.
  const alreadySent = await getSentEmails();

  const rows = (leads || [])
    .map((lead) => {
      const emailUsed = isDiscoveryFollowup
        ? lead.discovered_email ?? null
        : (resolvePrimaryEmail(lead) ?? lead.primary_email);
      // A proven-invalid address is auto-excluded here rather than at send
      // time. This is the single choke point every recipient passes through —
      // the wizard picker, the Lead Matrix hand-off, "add by filter", and the
      // API all land here — so enforcing it once closes the gap Operations
      // found where Lead-Matrix selections skipped the picker's own rule
      // (2026-09-02). Recorded as 'skipped' with a reason, not dropped
      // silently, so the campaign's recipient list explains itself.
      //
      // Note this covers `invalid` only. Never-verified leads are held back
      // by the send gate instead, which surfaces them for remove-or-verify —
      // auto-skipping those would hide a whole campaign's worth of
      // recipients behind a status pill.
      // A discovery follow-up targets discovered_email, so the verdict that
      // matters is that column's — verification_status describes
      // primary_email, which for these leads is usually the address that
      // already bounced. Gating on it would auto-skip the entire flow.
      const isInvalid = isDiscoveryFollowup
        ? lead.discovered_email_status === 'invalid'
        : lead.verification_status === 'invalid';
      const isDuplicate = !isInvalid && emailUsed != null && alreadySent.has(emailUsed.toLowerCase());
      const isSkipped = isInvalid || isDuplicate;
      return {
        campaign_id: campaignId,
        lead_id: lead.id,
        email_used: emailUsed,
        status: isSkipped ? 'skipped' : 'pending',
        skip_reason: isInvalid
          ? 'email_invalid'
          : isDuplicate
            ? 'already_contacted_in_another_campaign'
            : null,
      };
    })
    // Drop rows the discovery follow-up can't actually target — a lead with
    // no accepted discovered_email shouldn't end up in this campaign.
    .filter((row) => row.email_used);

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

/**
 * Removes campaign memberships. Used by the campaign send-block remediation
 * flow: when the send gate refuses because some recipients are proven
 * undeliverable, the operator needs a one-click way to drop exactly those
 * rows and launch, rather than deleting the campaign and rebuilding it.
 *
 * Only `pending` rows are removable — a row that has already been sent is a
 * record of an email that left the building, and deleting it would corrupt
 * both the dedup set and the campaign's own counts.
 *
 * Accepts campaign_lead ids (what the send-block payload hands back) and/or
 * lead ids (what the UI has when the operator picks rows off a list).
 */
export async function removeCampaignLeads(
  campaignId: string,
  opts: { campaignLeadIds?: string[]; leadIds?: string[] },
): Promise<number> {
  const supabase = getSupabase();
  const byRow = (opts.campaignLeadIds ?? []).filter(Boolean);
  const byLead = (opts.leadIds ?? []).filter(Boolean);
  if (byRow.length === 0 && byLead.length === 0) return 0;

  let removed = 0;
  // Two statements rather than one `.or()`: PostgREST's or() with in-lists
  // gets unwieldy and this path runs at most twice per request.
  for (const [column, ids] of [['id', byRow], ['lead_id', byLead]] as const) {
    if (!ids.length) continue;
    const { error, count } = await supabase
      .from('campaign_leads')
      .delete({ count: 'exact' })
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .in(column, ids);
    if (error) throw new Error(error.message);
    removed += count || 0;
  }
  return removed;
}

/**
 * Campaign memberships for a single lead. Used by the Lead Detail Activity
 * timeline to resolve a note's campaign_id → the campaign_lead_id the Inbox
 * deep-link (/inbox?open=<campaign_lead_id>) needs, so timeline entries can
 * link to the actual conversation.
 */
export async function getCampaignLeadsByLead(leadId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('id, campaign_id, status')
    .eq('lead_id', leadId);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addLeadsByFilter(campaignId: string, filters: { country?: string; category?: string }) {
  const supabase = getSupabase();

  let query = supabase
    .from('leads')
    .select('id, primary_email, trustpilot_email, website_email, discovered_email, affiliate_email, trustpilot_email_status, website_email_status, discovered_email_status, affiliate_email_status')
    .not('primary_email', 'is', null)
    .eq('blocked', false) // skip Trustpilot-flagged leads (migration 048)
    .eq('do_not_contact', false); // skip opted-out leads (migration 050)

  query = applyRecipientFilters(query, filters);

  const { data: leads, error: leadsError } = await query;
  if (leadsError) throw new Error(leadsError.message);
  if (!leads || leads.length === 0) return [];

  const alreadySent = await getSentEmails();

  const rows = leads.map((lead) => {
    const emailUsed = resolvePrimaryEmail(lead) ?? lead.primary_email;
    const isSkipped = emailUsed != null && alreadySent.has(emailUsed.toLowerCase());
    return {
      campaign_id: campaignId,
      lead_id: lead.id,
      email_used: emailUsed,
      status: isSkipped ? 'skipped' : 'pending',
      skip_reason: isSkipped ? 'already_contacted_in_another_campaign' : null,
    };
  });

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

  const stats = { pending: 0, sent: 0, opened: 0, replied: 0, auto_replied: 0, bounced: 0, skipped: 0 };
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
    .not('primary_email', 'is', null)
    .eq('blocked', false) // preview must match the recipients we'd actually send to (migration 048)
    .eq('do_not_contact', false); // exclude opted-out leads (migration 050)

  query = applyRecipientFilters(query, filters);

  const { data, count, error } = await query.limit(10);
  if (error) throw new Error(error.message);

  return {
    count: count ?? 0,
    sample: data || [],
  };
}

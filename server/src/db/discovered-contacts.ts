/**
 * Data layer for the discovered_contacts review queue.
 *
 * Auto-replies that pass the detector + extractor produce one row here per
 * candidate (email or partner-brand URL). Rows start at status='pending_review';
 * the user accepts, dismisses, or — for URL candidates — spawns a new lead.
 *
 * Promotion rules:
 *   - kind='email' + accept   → leads.discovered_email is written and
 *                                primary_email is recomputed via the resolver.
 *   - kind='url'   + accept   → no lead change (the URL had emails harvested by
 *                                the worker; harvested emails sit as their own
 *                                kind='email' rows that the user accepts).
 *   - kind='url'   + spawn    → a new lead row is created from scrape_result
 *                                and the discovered_contacts row's status flips
 *                                to 'spawned_lead'.
 */

import { getSupabase } from '../lib/supabase.js';
import { createNote } from './notes.js';
import {
  resolvePrimaryEmailWithSource,
  statusForPrimaryEmail,
} from '../services/email/resolve-primary-email.js';

export type DiscoveredKind = 'email' | 'url';
export type DiscoveredStatus = 'pending_review' | 'accepted' | 'dismissed' | 'spawned_lead';
export type DiscoveredVerification = 'valid' | 'invalid' | 'catch-all' | 'unknown' | null;

export interface DiscoveredContact {
  id: string;
  lead_id: string;
  source_campaign_lead_id: string | null;
  kind: DiscoveredKind;
  value: string;
  role: string | null;
  score: number;
  verification_status: DiscoveredVerification;
  scrape_result: Record<string, unknown> | null;
  status: DiscoveredStatus;
  auto_reply_message_id: string | null;
  auto_reply_metadata: Record<string, unknown> | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export interface InsertDiscoveredInput {
  lead_id: string;
  source_campaign_lead_id?: string | null;
  kind: DiscoveredKind;
  value: string;
  role?: string | null;
  score: number;
  verification_status?: DiscoveredVerification;
  scrape_result?: Record<string, unknown> | null;
  auto_reply_message_id?: string | null;
  auto_reply_metadata?: Record<string, unknown> | null;
}

/**
 * Insert a discovered candidate. Idempotent on (lead_id, lower(value)) — a
 * repeat auto-reply that surfaces the same address won't pile up duplicate
 * pending rows. Returns the existing row when there's a conflict so callers
 * can still attach the latest auto_reply_metadata.
 */
export async function insertDiscoveredContact(input: InsertDiscoveredInput): Promise<DiscoveredContact | null> {
  const supabase = getSupabase();

  // Cheap dedupe: look for an existing pending row on the same (lead_id, value)
  const { data: existing } = await supabase
    .from('discovered_contacts')
    .select('*')
    .eq('lead_id', input.lead_id)
    .ilike('value', input.value)
    .in('status', ['pending_review', 'accepted', 'spawned_lead'])
    .maybeSingle();

  if (existing) {
    return existing as DiscoveredContact;
  }

  const { data, error } = await supabase
    .from('discovered_contacts')
    .insert({
      lead_id: input.lead_id,
      source_campaign_lead_id: input.source_campaign_lead_id ?? null,
      kind: input.kind,
      value: input.value,
      role: input.role ?? null,
      score: input.score,
      verification_status: input.verification_status ?? null,
      scrape_result: input.scrape_result ?? null,
      auto_reply_message_id: input.auto_reply_message_id ?? null,
      auto_reply_metadata: input.auto_reply_metadata ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error('[discovered-contacts] insert failed:', error.message);
    return null;
  }
  return data as DiscoveredContact;
}

export async function listPendingByLead(leadId: string): Promise<DiscoveredContact[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('discovered_contacts')
    .select('*')
    .eq('lead_id', leadId)
    .eq('status', 'pending_review')
    .order('score', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as DiscoveredContact[];
}

export interface ListForReviewFilters {
  kind?: DiscoveredKind;
  status?: DiscoveredStatus;
  limit?: number;
  offset?: number;
}

export async function listForReview(
  filters: ListForReviewFilters = {},
): Promise<{ data: Array<DiscoveredContact & { lead: Record<string, unknown> | null }>; total: number }> {
  const supabase = getSupabase();
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;
  const status = filters.status ?? 'pending_review';

  let query = supabase
    .from('discovered_contacts')
    .select('*, lead:leads(*)', { count: 'exact' })
    .eq('status', status);
  if (filters.kind) query = query.eq('kind', filters.kind);

  const { data, error, count } = await query
    .order('score', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);
  return {
    data: (data ?? []) as Array<DiscoveredContact & { lead: Record<string, unknown> | null }>,
    total: count ?? 0,
  };
}

/**
 * Accept a discovered email candidate. Promotes the value to
 * leads.discovered_email and rebuilds primary_email + verification_status.
 *
 * For kind='url' candidates Accept just marks reviewed without modifying the
 * lead — URLs surface harvested emails as their own kind='email' rows; those
 * are the actionable ones. Caller can use spawnLeadFromUrl() if the URL
 * represents a separate brand worth tracking as a new lead.
 */
export async function acceptContact(
  id: string,
  opts: { reviewedBy?: string } = {},
): Promise<{ contact: DiscoveredContact; lead: Record<string, unknown> | null }> {
  const supabase = getSupabase();

  const { data: contact, error: fetchErr } = await supabase
    .from('discovered_contacts')
    .select('*')
    .eq('id', id)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!contact) throw new Error('Discovered contact not found');
  if ((contact as DiscoveredContact).status !== 'pending_review') {
    throw new Error(`Cannot accept a ${(contact as DiscoveredContact).status} contact`);
  }

  let updatedLead: Record<string, unknown> | null = null;

  if (contact.kind === 'email') {
    // Pull the lead's current email fields so we can run the resolver against
    // the post-accept state. Including all sources so primary_email reflects
    // discovered when it's the strongest signal.
    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .select('id, primary_email, trustpilot_email, website_email, discovered_email, affiliate_email, trustpilot_email_status, website_email_status, discovered_email_status, affiliate_email_status')
      .eq('id', contact.lead_id)
      .single();
    if (leadErr) throw new Error(leadErr.message);

    const verifiedStatus = (contact.verification_status ?? null) as DiscoveredVerification;

    const nextLead = {
      ...lead,
      discovered_email: contact.value,
      discovered_email_status: verifiedStatus,
    };

    const { email: newPrimary } = resolvePrimaryEmailWithSource(nextLead);
    const newPrimaryStatus = statusForPrimaryEmail(nextLead);

    const patch: Record<string, unknown> = {
      discovered_email: contact.value,
      discovered_email_status: verifiedStatus,
      primary_email: newPrimary,
      verification_status: newPrimaryStatus,
      email_verified: newPrimaryStatus === 'valid',
    };

    const { data: updated, error: updErr } = await supabase
      .from('leads')
      .update(patch)
      .eq('id', contact.lead_id)
      .select()
      .single();
    if (updErr) throw new Error(updErr.message);
    updatedLead = updated;
  }

  const { data: updatedContact, error: contactErr } = await supabase
    .from('discovered_contacts')
    .update({
      status: 'accepted',
      reviewed_at: new Date().toISOString(),
      reviewed_by: opts.reviewedBy ?? null,
    })
    .eq('id', id)
    .select()
    .single();
  if (contactErr) throw new Error(contactErr.message);

  // Activity log
  try {
    await createNote(contact.lead_id, {
      type: 'discovered_contact_accepted',
      content: contact.kind === 'email'
        ? `Discovered ${contact.role ?? 'contact'} email ${contact.value} accepted; primary_email rebuilt.`
        : `Discovered URL ${contact.value} marked accepted.`,
      metadata: {
        discovered_contact_id: id,
        kind: contact.kind,
        value: contact.value,
        role: contact.role,
        verification_status: contact.verification_status,
      },
    });
  } catch (e) {
    console.warn('[discovered-contacts] note-write failed:', e instanceof Error ? e.message : e);
  }

  return { contact: updatedContact as DiscoveredContact, lead: updatedLead };
}

export async function dismissContact(
  id: string,
  opts: { reviewedBy?: string; reason?: string } = {},
): Promise<DiscoveredContact> {
  const supabase = getSupabase();

  const { data: contact, error: fetchErr } = await supabase
    .from('discovered_contacts')
    .select('*')
    .eq('id', id)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!contact) throw new Error('Discovered contact not found');

  const { data: updated, error } = await supabase
    .from('discovered_contacts')
    .update({
      status: 'dismissed',
      reviewed_at: new Date().toISOString(),
      reviewed_by: opts.reviewedBy ?? null,
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);

  try {
    await createNote(contact.lead_id, {
      type: 'discovered_contact_dismissed',
      content: `Discovered ${contact.kind} ${contact.value} dismissed${opts.reason ? `: ${opts.reason}` : ''}.`,
      metadata: { discovered_contact_id: id, kind: contact.kind, value: contact.value, reason: opts.reason ?? null },
    });
  } catch (e) {
    console.warn('[discovered-contacts] note-write failed:', e instanceof Error ? e.message : e);
  }

  return updated as DiscoveredContact;
}

/**
 * Spawn a new lead from a kind='url' discovery's scrape_result. Used when the
 * user decides the partner-brand URL is its own company, not just a routing
 * page on the existing lead.
 */
export async function spawnLeadFromUrl(
  id: string,
  opts: { reviewedBy?: string } = {},
): Promise<{ contact: DiscoveredContact; newLeadId: string }> {
  const supabase = getSupabase();

  const { data: contact, error: fetchErr } = await supabase
    .from('discovered_contacts')
    .select('*, lead:leads(country, category)')
    .eq('id', id)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!contact) throw new Error('Discovered contact not found');
  if (contact.kind !== 'url') {
    throw new Error('spawnLeadFromUrl is only valid for kind=url contacts');
  }
  if (contact.status !== 'pending_review') {
    throw new Error(`Cannot spawn from a ${contact.status} contact`);
  }

  const scrape = (contact.scrape_result ?? {}) as Record<string, unknown>;
  const harvestedEmails = Array.isArray(scrape.emails) ? (scrape.emails as string[]) : [];
  const primaryEmail = harvestedEmails.find((e) => typeof e === 'string' && e.includes('@')) ?? null;
  const companyName = (scrape.company_name as string | undefined) ?? extractCompanyFromUrl(contact.value);
  const screenshotPath = (scrape.screenshot_path as string | undefined) ?? null;

  // Use the URL itself (with scheme) as the unique trustpilot_url surrogate so
  // we don't collide with real Trustpilot scrapes. The "spawn:" prefix mirrors
  // the manual upsert pattern from upsertManualLeads.
  const surrogateKey = `spawn:${contact.value.toLowerCase()}`;
  const parentCountry = (contact.lead as { country?: string } | null)?.country ?? null;
  const parentCategory = (contact.lead as { category?: string } | null)?.category ?? null;

  const { data: newLead, error: insertErr } = await supabase
    .from('leads')
    .upsert({
      trustpilot_url: surrogateKey,
      website_url: contact.value,
      website_email: primaryEmail,
      website_email_status: null,
      primary_email: primaryEmail,
      company_name: companyName,
      screenshot_path: screenshotPath,
      country: parentCountry,
      category: parentCategory,
      outreach_status: 'new',
    }, { onConflict: 'trustpilot_url', ignoreDuplicates: false })
    .select('id')
    .single();
  if (insertErr) throw new Error(insertErr.message);

  const { data: updatedContact, error: contactErr } = await supabase
    .from('discovered_contacts')
    .update({
      status: 'spawned_lead',
      reviewed_at: new Date().toISOString(),
      reviewed_by: opts.reviewedBy ?? null,
      auto_reply_metadata: {
        ...(contact.auto_reply_metadata ?? {}),
        spawned_lead_id: newLead.id,
      },
    })
    .eq('id', id)
    .select()
    .single();
  if (contactErr) throw new Error(contactErr.message);

  try {
    await createNote(contact.lead_id, {
      type: 'lead_spawned_from_discovery',
      content: `Spawned new lead from discovered URL ${contact.value} (company: ${companyName}).`,
      metadata: {
        discovered_contact_id: id,
        new_lead_id: newLead.id,
        url: contact.value,
        company_name: companyName,
      },
    });
  } catch (e) {
    console.warn('[discovered-contacts] note-write failed:', e instanceof Error ? e.message : e);
  }

  return { contact: updatedContact as DiscoveredContact, newLeadId: newLead.id };
}

function extractCompanyFromUrl(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    return url;
  }
}

/** Count of pending discoveries — drives the sidebar badge. */
export async function countPending(): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('discovered_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending_review');
  if (error) {
    console.warn('[discovered-contacts] countPending failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

/** Used by the worker to find rows still waiting for verification or scrape. */
export async function listUnprocessed(opts: { kind: DiscoveredKind; limit?: number }): Promise<DiscoveredContact[]> {
  const supabase = getSupabase();
  let query = supabase
    .from('discovered_contacts')
    .select('*')
    .eq('status', 'pending_review')
    .eq('kind', opts.kind);

  if (opts.kind === 'email') {
    query = query.is('verification_status', null);
  } else {
    query = query.is('scrape_result', null);
  }

  const { data, error } = await query
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 25);
  if (error) {
    console.warn('[discovered-contacts] listUnprocessed failed:', error.message);
    return [];
  }
  return (data ?? []) as DiscoveredContact[];
}

export async function setVerificationStatus(id: string, status: DiscoveredVerification): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('discovered_contacts')
    .update({ verification_status: status })
    .eq('id', id);
  if (error) console.warn('[discovered-contacts] setVerificationStatus failed:', error.message);
}

export async function setScrapeResult(id: string, scrape: Record<string, unknown>): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('discovered_contacts')
    .update({ scrape_result: scrape })
    .eq('id', id);
  if (error) console.warn('[discovered-contacts] setScrapeResult failed:', error.message);
}

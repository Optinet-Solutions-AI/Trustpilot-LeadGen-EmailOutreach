import { getSupabase } from '../lib/supabase.js';

// The legacy leads.screenshot_path is only populated for Trustpilot. Every
// other platform stores its canonical screenshot on lead_platform_presences.
// The frontend renders the top-level lead.screenshot_path, so when the legacy
// column is null we backfill it from the first presence that has one — this is
// what makes Yelp/TripAdvisor lead images actually show in the UI.
function coalesceScreenshot(row: any): any {
  if (row && !row.screenshot_path) {
    const presences = Array.isArray(row.lead_platform_presences) ? row.lead_platform_presences : [];
    const withShot = presences.find((p: any) => p && p.screenshot_path);
    if (withShot) row.screenshot_path = withShot.screenshot_path;
  }
  return row;
}

export interface LeadFilters {
  status?: string;
  country?: string;
  category?: string;
  search?: string;
  minRating?: number;
  maxRating?: number;
  hasEmail?: boolean;
  verificationStatus?: 'valid' | 'invalid' | 'catch-all' | 'unknown';
  // Per-platform filter — when set, restricts the result to leads that have
  // a row in lead_platform_presences for the given platform name. Used by
  // the per-platform "Trustpilot Leads" / "TripAdvisor Leads" pages.
  platform?: string;
  // Redirect filtering: 'only' returns leads where redirects_to IS NOT NULL
  // (the dedicated Redirected Leads page); 'exclude' filters them out so
  // standard outreach views never include them. 'all' (default) ignores it.
  redirected?: 'only' | 'exclude' | 'all';
  // Blocked = Trustpilot consumer-alert flagged (migration 048). 'only' shows
  // just blocked leads (the "how many did we scrape" count), 'exclude' hides
  // them, 'all' (default) shows everything so the matrix surfaces the badge.
  blocked?: 'only' | 'exclude' | 'all';
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export async function getLeads(filters: LeadFilters = {}) {
  const supabase = getSupabase();
  const page = filters.page || 1;
  const limit = filters.limit || 25;
  const offset = (page - 1) * limit;

  // Platform filter — use PostgREST's embedded-resource JOIN so the filter
  // resolves server-side instead of materializing the full ID list in the
  // client query URL. The `!inner` modifier turns the embed into an INNER
  // JOIN, and filtering on `lead_platform_presences.platform` constrains
  // the parent rows. This scales: Trustpilot today is 6k+ rows, which
  // would blow the URL length limit if we used `.in('id', […])`.
  let query = filters.platform
    ? supabase
        .from('leads')
        .select(
          '*, lead_platform_presences!inner(platform, profile_url, screenshot_path, author_handle, is_business_profile), lead_platform_posts(post_url, content_excerpt, posted_at, scraped_at, group_id, group_name)',
          { count: 'exact' },
        )
        .eq('lead_platform_presences.platform', filters.platform)
    : supabase
        .from('leads')
        .select('*, lead_platform_presences(platform, screenshot_path)', { count: 'exact' });

  if (filters.status) query = query.eq('outreach_status', filters.status);
  // country + category use ILIKE substring match so operator typos and
  // partial typing still surface the right leads. Examples:
  //   "dentis"   matches "dentist" and "dental services"
  //   "plumb"    matches "plumber" and "plumbing"
  //   "new york" matches "New York, USA"
  if (filters.country) query = query.ilike('country', `%${filters.country}%`);
  if (filters.category) query = query.ilike('category', `%${filters.category}%`);
  if (filters.minRating) query = query.gte('star_rating', filters.minRating);
  if (filters.maxRating) query = query.lte('star_rating', filters.maxRating);
  if (filters.search) {
    query = query.or(`company_name.ilike.%${filters.search}%,website_url.ilike.%${filters.search}%,primary_email.ilike.%${filters.search}%`);
  }
  if (filters.hasEmail) {
    query = query.not('primary_email', 'is', null);
  }
  if (filters.verificationStatus) {
    query = query.eq('verification_status', filters.verificationStatus);
  }
  if (filters.redirected === 'only') {
    query = query.not('redirects_to', 'is', null);
  } else if (filters.redirected === 'exclude') {
    query = query.is('redirects_to', null);
  }
  if (filters.blocked === 'only') {
    query = query.eq('blocked', true);
  } else if (filters.blocked === 'exclude') {
    query = query.eq('blocked', false);
  }

  const EMAIL_SORT_COLUMNS = new Set(['primary_email', 'trustpilot_email', 'website_email']);
  const ALLOWED_SORT_COLUMNS = new Set([
    'company_name', 'star_rating', 'outreach_status',
    'country', 'category', 'primary_email', 'trustpilot_email', 'website_email',
    'created_at', 'scraped_at',
  ]);
  const sortCol = filters.sortBy && ALLOWED_SORT_COLUMNS.has(filters.sortBy) ? filters.sortBy : 'created_at';
  const sortAsc = filters.sortDir === 'asc';

  // For any email column: always put nulls last so leads with emails surface at the top
  const nullsFirst = EMAIL_SORT_COLUMNS.has(sortCol) ? false : undefined;

  // Always prioritize email-verification quality FIRST: valid > catch-all >
  // invalid > unknown > null. The user's chosen sort column becomes the
  // tiebreaker within each rank bucket. Backed by `verification_rank`
  // generated column (migration 034) with an index on it, so this is cheap.
  const { data, error, count } = await query
    .order('verification_rank', { ascending: true, nullsFirst: false })
    .order(sortCol, { ascending: sortAsc, nullsFirst })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);

  return {
    data: (data || []).map(coalesceScreenshot),
    total: count || 0,
    page,
    totalPages: Math.ceil((count || 0) / limit),
  };
}

/**
 * Returns lead IDs (with primary_email) matching filters — no pagination, no row data.
 * Used by the campaign wizard's "Select all valid" button to grab every
 * matching lead across all pages in one round-trip. Hard-capped at 5000
 * to keep the response size sane; the wizard refuses to bulk-select
 * beyond that for sender-reputation reasons anyway.
 *
 * primary_email is returned so the wizard can filter already-contacted
 * leads client-side against the global sent-set without a second round-trip.
 */
export async function getLeadIds(
  filters: LeadFilters = {},
): Promise<Array<{ id: string; primary_email: string | null }>> {
  const supabase = getSupabase();
  const MAX_IDS = 5000;

  let query = filters.platform
    ? supabase
        .from('leads')
        .select('id, primary_email, lead_platform_presences!inner(platform)')
        .eq('lead_platform_presences.platform', filters.platform)
    : supabase.from('leads').select('id, primary_email');

  if (filters.status) query = query.eq('outreach_status', filters.status);
  // country + category use ILIKE substring match so operator typos and
  // partial typing still surface the right leads. Examples:
  //   "dentis"   matches "dentist" and "dental services"
  //   "plumb"    matches "plumber" and "plumbing"
  //   "new york" matches "New York, USA"
  if (filters.country) query = query.ilike('country', `%${filters.country}%`);
  if (filters.category) query = query.ilike('category', `%${filters.category}%`);
  if (filters.minRating) query = query.gte('star_rating', filters.minRating);
  if (filters.maxRating) query = query.lte('star_rating', filters.maxRating);
  if (filters.search) {
    query = query.or(`company_name.ilike.%${filters.search}%,website_url.ilike.%${filters.search}%,primary_email.ilike.%${filters.search}%`);
  }
  if (filters.hasEmail) query = query.not('primary_email', 'is', null);
  if (filters.verificationStatus) query = query.eq('verification_status', filters.verificationStatus);
  if (filters.redirected === 'only') query = query.not('redirects_to', 'is', null);
  else if (filters.redirected === 'exclude') query = query.is('redirects_to', null);
  // This list feeds campaign recipient selection (wizard "select all") — never
  // hand back blocked leads. They're flagged out of outreach entirely.
  query = query.eq('blocked', false);

  const { data, error } = await query.range(0, MAX_IDS - 1);
  if (error) throw new Error(error.message);
  return (data || []).map((r: { id: string; primary_email: string | null }) => ({
    id: r.id,
    primary_email: r.primary_email ?? null,
  }));
}

export async function getLeadById(id: string) {
  const supabase = getSupabase();
  // LEFT-join platform presences + posts (no !inner) so review-platform leads
  // still return, while social leads carry their profile + captured posts. The
  // lead detail page needs lead_platform_posts to render the Facebook panel
  // (comment draft + "Open in James's browser"); the list endpoint already
  // joins these, but the single-lead fetch previously did not.
  const { data, error } = await supabase
    .from('leads')
    .select(
      '*, lead_platform_presences(platform, profile_url, screenshot_path, author_handle, is_business_profile), lead_platform_posts(post_url, content_excerpt, posted_at, scraped_at, group_id, group_name)',
    )
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return coalesceScreenshot(data);
}

export async function updateLead(id: string, patch: Record<string, unknown>) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('leads').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function bulkUpdateLeads(ids: string[], patch: Record<string, unknown>) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('leads').update(patch).in('id', ids).select();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteLead(id: string) {
  const supabase = getSupabase();
  const { error } = await supabase.from('leads').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function bulkDeleteLeads(ids: string[]): Promise<number> {
  const supabase = getSupabase();
  const { error, count } = await supabase
    .from('leads')
    .delete({ count: 'exact' })
    .in('id', ids);
  if (error) throw new Error(error.message);
  return count || 0;
}

// Upsert manually-entered email addresses as minimal lead records.
// Uses trustpilot_url = 'manual:<email>' as the unique key to avoid conflicts.
// Returns the IDs of all upserted leads.
export async function upsertManualLeads(emails: string[]): Promise<string[]> {
  const supabase = getSupabase();
  const records = emails.map((email) => ({
    trustpilot_url: `manual:${email.toLowerCase().trim()}`,
    primary_email: email.toLowerCase().trim(),
    company_name: email.toLowerCase().trim().split('@')[1]?.split('.')[0] || email,
    outreach_status: 'new',
  }));

  const { data, error } = await supabase
    .from('leads')
    .upsert(records, { onConflict: 'trustpilot_url', ignoreDuplicates: false })
    .select('id');

  if (error) throw new Error(error.message);
  return (data || []).map((r: { id: string }) => r.id);
}

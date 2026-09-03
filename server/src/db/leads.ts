import { getSupabase } from '../lib/supabase.js';
import { categoryOrFilter } from '../services/lead-categories.js';
import { countriesForLanguage } from '../services/lead-languages.js';

/**
 * campaign_leads statuses that mean "an email actually went out to this
 * address". Mirrors getSentEmails() in db/campaigns.ts — keep the two in
 * step. 'skipped' and 'pending' are deliberately absent: a skipped row is
 * proof we did NOT send, so it must never hide a lead from the picker.
 */
const CONTACTED_STATUSES = ['sent', 'opened', 'replied', 'auto_replied', 'bounced'];

// Sentinel for "language matched no countries" - a value no country column
// can hold, so the filter returns zero rows instead of silently returning
// every lead.
const NO_LANGUAGE_MATCH = '__no_language_match__';

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
  // The inverse of hasEmail, and NOT a verification verdict: a lead with no
  // address was never a candidate for verification at all. Broken out because
  // "not verified" and "no address on file" have completely different
  // remedies -- run the verifier, or run enrichment to go find an address.
  withoutEmail?: boolean;
  // Verifier verdict. 'unverified' is NOT a stored value — it means the
  // column is still NULL (never run through a verifier), which Operations
  // needs to see separately from 'unknown' (verifier ran, was inconclusive).
  verificationStatus?: VerificationFilter;
  // Restrict to an explicit id set. Used by the campaign wizard to re-read
  // leads handed over from the Lead Matrix so it can re-apply the
  // invalid-email rule on ids it did not select itself.
  ids?: string[];
  // What the lead IS, not whether we can reach it (migration 063):
  // 'operator' is the sellable business; affiliate / redirect / dead /
  // flagged are the junk a review-site scrape drags along with it;
  // 'unclassified' means no signal decided yet. Accepts a comma-joined list
  // so the UI can say "operator + unclassified" — the practical working set
  // while classification coverage is still filling in.
  prospectType?: string[];
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
  // Outreach language — expands to every country code that speaks it, so a
  // campaign can target one language across several markets (Italian =
  // IT + CH, English = US/GB/CA/AU/IE/...). Combines with `country` if
  // both are given. An unrecognised language matches NOTHING rather than
  // everything, so a typo can never silently widen the recipient set.
  language?: string;
  // Hide leads that have ALREADY BEEN SENT a campaign email. Used by the
  // campaign wizard's recipient picker so operators never pick someone who
  // would only land as 'skipped' at send time. Implemented as a PostgREST
  // anti-join (`campaign_leads!left` + `campaign_leads=is.null`) rather than
  // a `not.in(<addresses>)` filter: there are ~2k contacted addresses and
  // spelling them into the query string is ~51 KB of URL. The anti-join keeps
  // the exclusion in Postgres, so `count` and pagination stay exact.
  //
  // NOTE this matches on lead_id, so it misses a duplicate lead row that
  // shares an already-contacted address (46 rows as of 2026-08-28, ~2% of
  // contacted leads). The picker also runs its email-level check client-side
  // to catch those; send-time dedup in routes/campaigns.ts is by email and
  // remains the authoritative gate.
  excludeContacted?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

/**
 * Verifier verdicts the UI can filter on. The four real values are stored on
 * leads.verification_status; 'unverified' is the synthetic bucket for NULL.
 */
export const VERIFICATION_FILTERS = ['valid', 'invalid', 'catch-all', 'unknown', 'unverified'] as const;
export type VerificationFilter = (typeof VERIFICATION_FILTERS)[number];

/** Narrow a raw query-string value to a VerificationFilter, or undefined. */
export function parseVerificationFilter(raw: unknown): VerificationFilter | undefined {
  return typeof raw === 'string' && (VERIFICATION_FILTERS as readonly string[]).includes(raw)
    ? (raw as VerificationFilter)
    : undefined;
}

/**
 * Whether leads.prospect_type exists yet (migration 063).
 *
 * WHY THIS PROBE EXISTS: the Lead Matrix filters on prospect_type by default
 * (it hides affiliate / redirect / dead rows), so if the API ships before the
 * SQL migration is applied, PostgREST fails the query with "column
 * leads.prospect_type does not exist" and the whole Lead Matrix 500s. Deploy
 * order across Cloud Run and the Supabase SQL editor is manual and therefore
 * not guaranteed, so the filter degrades to a no-op instead of taking the
 * page down, and starts working the moment the migration lands.
 *
 * Cached per process. `null` = not yet probed.
 */
let prospectTypeColumnExists: boolean | null = null;

async function hasProspectTypeColumn(): Promise<boolean> {
  if (prospectTypeColumnExists !== null) return prospectTypeColumnExists;
  const supabase = getSupabase();
  const { error } = await supabase.from('leads').select('prospect_type').limit(1);
  // Only a missing-column error means "not migrated". Anything else (network,
  // auth) must not latch a false negative that survives for the process's
  // lifetime, so leave it unprobed and try again next request.
  if (error) {
    if (/prospect_type/i.test(error.message)) {
      prospectTypeColumnExists = false;
      console.warn(
        '[leads] leads.prospect_type is missing — apply supabase/migrations/063_lead_prospect_type.sql. ' +
        'Prospect-type filtering is disabled until then.',
      );
      return false;
    }
    return false;
  }
  prospectTypeColumnExists = true;
  return true;
}

/**
 * Applies every row-level LeadFilters predicate to an already-built PostgREST
 * query. Extracted so the list query and the verification-count queries can
 * never drift apart — a count that disagrees with the list it annotates is
 * worse than no count at all.
 *
 * Excluded on purpose: pagination, ordering, and the excludeContacted
 * anti-join (which needs the campaign_leads embed in the select string, so it
 * belongs with query construction).
 */
function applyLeadFilters<T>(query: T, filters: LeadFilters): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = query as any;
  if (filters.status) q = q.eq('outreach_status', filters.status);
  // country uses ILIKE substring match so operator typos and partial typing
  // still surface the right leads ("new york" matches "New York, USA").
  if (filters.country) q = q.ilike('country', `%${filters.country}%`);
  // category is FAMILY-aware: each scraping platform writes its own taxonomy
  // string, so one trade ends up stored under several labels (plumber /
  // plumbers / plumbing). A plain substring match found only some of them.
  // categoryOrFilter expands the requested value to every label in its family
  // — source of truth is tools/db/category_canonical.py. Partial typing still
  // works, because the expansion is a set of ILIKE substring needles rather
  // than equality ("plumb" -> %plumb%).
  if (filters.category) {
    const categoryOr = categoryOrFilter(filters.category);
    if (categoryOr) q = q.or(categoryOr);
  }
  if (filters.minRating) q = q.gte('star_rating', filters.minRating);
  if (filters.maxRating) q = q.lte('star_rating', filters.maxRating);
  if (filters.search) {
    q = q.or(`company_name.ilike.%${filters.search}%,website_url.ilike.%${filters.search}%,primary_email.ilike.%${filters.search}%`);
  }
  if (filters.hasEmail) {
    q = q.not('primary_email', 'is', null);
  }
  if (filters.withoutEmail) {
    // "No address on file" must mean no address ANYWHERE, not just an empty
    // primary_email. primary_email is a denormalised cache; the address a
    // campaign actually sends to is resolved from the source columns by
    // resolvePrimaryEmail(). Checking only the cache surfaced leads that
    // plainly showed a Trustpilot or site address in the table -- reported
    // 2026-09-02 with register@casinomedvisa.com sitting under a "No
    // address" filter.
    q = q
      .is('primary_email', null)
      .is('trustpilot_email', null)
      .is('website_email', null)
      .is('discovered_email', null)
      .is('affiliate_email', null);
  }
  if (filters.verificationStatus === 'unverified') {
    q = q.is('verification_status', null);
  } else if (filters.verificationStatus) {
    q = q.eq('verification_status', filters.verificationStatus);
  }
  if (filters.ids && filters.ids.length) {
    q = q.in('id', filters.ids);
  }
  // Gated on `prospectTypeColumnExists` rather than probing here — this
  // function is sync, and callers resolve the probe before building a query.
  if (filters.prospectType && filters.prospectType.length && prospectTypeColumnExists !== false) {
    q = q.in('prospect_type', filters.prospectType);
  }
  if (filters.redirected === 'only') {
    q = q.not('redirects_to', 'is', null);
  } else if (filters.redirected === 'exclude') {
    q = q.is('redirects_to', null);
  }
  if (filters.blocked === 'only') {
    q = q.eq('blocked', true);
  } else if (filters.blocked === 'exclude') {
    q = q.eq('blocked', false);
  }
  if (filters.language) {
    const codes = countriesForLanguage(filters.language);
    // Fail closed on an unknown language — see the LeadFilters comment.
    q = codes.length ? q.in('country', codes) : q.eq('country', NO_LANGUAGE_MATCH);
  }
  return q as T;
}

export async function getLeads(filters: LeadFilters = {}) {
  const supabase = getSupabase();
  // Resolve the migration-063 probe before any query is built — see
  // hasProspectTypeColumn().
  if (filters.prospectType?.length) await hasProspectTypeColumn();
  const page = filters.page || 1;
  const limit = filters.limit || 25;
  const offset = (page - 1) * limit;

  // Platform filter — use PostgREST's embedded-resource JOIN so the filter
  // resolves server-side instead of materializing the full ID list in the
  // client query URL. The `!inner` modifier turns the embed into an INNER
  // JOIN, and filtering on `lead_platform_presences.platform` constrains
  // the parent rows. This scales: Trustpilot today is 6k+ rows, which
  // would blow the URL length limit if we used `.in('id', […])`.
  // Embedding campaign_leads is what makes the excludeContacted anti-join
  // possible — the embed itself returns nothing useful, it exists so the
  // `campaign_leads=is.null` filter has a relationship to hang off.
  const contactedEmbed = filters.excludeContacted ? ', campaign_leads!left(id)' : '';

  let query = filters.platform
    ? supabase
        .from('leads')
        .select(
          '*, lead_platform_presences!inner(platform, profile_url, screenshot_path, author_handle, is_business_profile), lead_platform_posts(post_url, content_excerpt, posted_at, scraped_at, group_id, group_name)' + contactedEmbed,
          { count: 'exact' },
        )
        .eq('lead_platform_presences.platform', filters.platform)
    : supabase
        .from('leads')
        .select('*, lead_platform_presences(platform, screenshot_path)' + contactedEmbed, { count: 'exact' });

  query = applyLeadFilters(query, filters);
  // Anti-join: constrain the embed to real sends, then keep only parents
  // whose embed came back empty — i.e. leads never actually emailed.
  if (filters.excludeContacted) {
    query = query
      .in('campaign_leads.status', CONTACTED_STATUSES)
      .is('campaign_leads', null);
  }
  if (filters.language) {
    const codes = countriesForLanguage(filters.language);
    // Fail closed on an unknown language — see the LeadFilters comment.
    query = codes.length ? query.in('country', codes) : query.eq('country', NO_LANGUAGE_MATCH);
  }
  // Anti-join: constrain the embed to real sends, then keep only parents
  // whose embed came back empty — i.e. leads never actually emailed.
  if (filters.excludeContacted) {
    query = query
      .in('campaign_leads.status', CONTACTED_STATUSES)
      .is('campaign_leads', null);
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
  if (filters.prospectType?.length) await hasProspectTypeColumn();

  const contactedEmbed = filters.excludeContacted ? ', campaign_leads!left(id)' : '';

  let query = filters.platform
    ? supabase
        .from('leads')
        .select('id, primary_email, lead_platform_presences!inner(platform)' + contactedEmbed)
        .eq('lead_platform_presences.platform', filters.platform)
    : supabase.from('leads').select('id, primary_email' + contactedEmbed);

  if (filters.status) query = query.eq('outreach_status', filters.status);
  // country uses ILIKE substring match so operator typos and partial typing
  // still surface the right leads ("new york" matches "New York, USA").
  if (filters.country) query = query.ilike('country', `%${filters.country}%`);
  // category is FAMILY-aware: each scraping platform writes its own taxonomy
  // string, so one trade ends up stored under several labels (plumber /
  // plumbers / plumbing). A plain substring match found only some of them.
  // categoryOrFilter expands the requested value to every label in its family
  // — source of truth is tools/db/category_canonical.py. Partial typing still
  // works, because the expansion is a set of ILIKE substring needles rather
  // than equality ("plumb" -> %plumb%).
  if (filters.category) {
    const categoryOr = categoryOrFilter(filters.category);
    if (categoryOr) query = query.or(categoryOr);
  }
  if (filters.minRating) query = query.gte('star_rating', filters.minRating);
  if (filters.maxRating) query = query.lte('star_rating', filters.maxRating);
  if (filters.search) {
    query = query.or(`company_name.ilike.%${filters.search}%,website_url.ilike.%${filters.search}%,primary_email.ilike.%${filters.search}%`);
  }
  if (filters.hasEmail) query = query.not('primary_email', 'is', null);
  if (filters.verificationStatus === 'unverified') query = query.is('verification_status', null);
  else if (filters.verificationStatus) query = query.eq('verification_status', filters.verificationStatus);
  if (filters.ids && filters.ids.length) query = query.in('id', filters.ids);
  // Mirrors applyLeadFilters — this list feeds campaign recipient selection,
  // so a "select all" must respect the same prospect-type narrowing the
  // operator sees on screen. See hasProspectTypeColumn() for the gate.
  if (filters.prospectType?.length && prospectTypeColumnExists !== false) {
    query = query.in('prospect_type', filters.prospectType);
  }
  if (filters.redirected === 'only') query = query.not('redirects_to', 'is', null);
  else if (filters.redirected === 'exclude') query = query.is('redirects_to', null);
  // This list feeds campaign recipient selection (wizard "select all") — never
  // hand back blocked leads. They're flagged out of outreach entirely.
  query = query.eq('blocked', false);
  if (filters.language) {
    const codes = countriesForLanguage(filters.language);
    query = codes.length ? query.in('country', codes) : query.eq('country', NO_LANGUAGE_MATCH);
  }
  // Same anti-join as getLeads: "select all valid" must not pull in leads
  // that were already emailed, or the campaign fills with skipped rows.
  if (filters.excludeContacted) {
    query = query
      .in('campaign_leads.status', CONTACTED_STATUSES)
      .is('campaign_leads', null);
  }

  const { data, error } = await query.range(0, MAX_IDS - 1);
  if (error) throw new Error(error.message);
  // The select string is concatenated at runtime (the optional campaign_leads
  // embed), so supabase-js can't infer a row type from it and falls back to
  // GenericStringError. The shape is still exactly what we asked for.
  const rows = (data || []) as unknown as Array<{ id: string; primary_email: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    primary_email: r.primary_email ?? null,
  }));
}

/**
 * Per-verdict lead counts for one filter set — the numbers behind the Lead
 * Matrix's verification chips.
 *
 * WHY THIS EXISTS: the "Has Email" filter counts every row carrying any
 * address, which Operations read as "sendable". It isn't — an address is only
 * sendable once a verifier has returned `valid`, and a large slice of the
 * book is still unverified or came back invalid/catch-all/unknown. Showing
 * the split next to the toggle makes the real sendable audience visible
 * instead of implied.
 *
 * Implemented as N head-only count queries rather than one big read: PostgREST
 * returns an exact count without shipping rows, so this stays cheap even on a
 * 6k-row book, and the numbers are guaranteed to agree with the list query
 * because they run through the same filter applier.
 */
export async function getVerificationCounts(
  filters: LeadFilters = {},
): Promise<Record<VerificationFilter | 'total' | 'sendable' | 'no_email', number>> {
  const supabase = getSupabase();
  // Resolve the migration-063 probe before any query is built — see
  // hasProspectTypeColumn().
  if (filters.prospectType?.length) await hasProspectTypeColumn();

  const countFor = async (
    verification?: VerificationFilter,
    mode: 'as-filtered' | 'require-email' | 'no-email' = 'as-filtered',
  ): Promise<number> => {
    const scoped: LeadFilters = {
      ...filters,
      verificationStatus: verification,
      hasEmail: mode === 'require-email' ? true : filters.hasEmail,
      withoutEmail: mode === 'no-email' ? true : filters.withoutEmail,
      // Counts are about the whole filtered book, not one page of it.
      page: undefined,
      limit: undefined,
    };
    const contactedEmbed = scoped.excludeContacted ? ', campaign_leads!left(id)' : '';
    let query = scoped.platform
      ? supabase
          .from('leads')
          .select('id, lead_platform_presences!inner(platform)' + contactedEmbed, { count: 'exact', head: true })
          .eq('lead_platform_presences.platform', scoped.platform)
      : supabase.from('leads').select('id' + contactedEmbed, { count: 'exact', head: true });
    query = applyLeadFilters(query, scoped);
    // Same anti-join getLeads uses. It lives here rather than in
    // applyLeadFilters because it depends on the campaign_leads embed being
    // in the select string, which is a query-construction concern. Without
    // it the embed would be requested and then ignored, and a count taken
    // with excludeContacted would silently include already-emailed leads —
    // i.e. over-report the sendable audience, which is the exact failure
    // these counts exist to prevent.
    if (scoped.excludeContacted) {
      query = query
        .in('campaign_leads.status', CONTACTED_STATUSES)
        .is('campaign_leads', null);
    }
    const { count, error } = await query;
    if (error) throw new Error(error.message);
    return count ?? 0;
  };

  const [total, valid, invalid, catchAll, unknown, unverified, sendable, noEmail] = await Promise.all([
    countFor(undefined),
    countFor('valid'),
    countFor('invalid'),
    countFor('catch-all'),
    countFor('unknown'),
    countFor('unverified'),
    // "Sendable" is the only number that answers Operations' actual question:
    // how many of these can go out today. Valid verdict AND an address on file.
    countFor('valid', 'require-email'),
    // Leads with no address at all. Reported alongside the verdicts rather
    // than inside them: there was never anything here for a verifier to
    // decide, so the remedy is enrichment, not verification.
    countFor(undefined, 'no-email'),
  ]);

  return { total, valid, invalid, 'catch-all': catchAll, unknown, unverified, sendable, no_email: noEmail };
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

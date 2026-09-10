/**
 * Ordering for the lead list.
 *
 * The default matrix sorts by `verification_rank` first — valid > catch-all >
 * invalid > unknown > null — so the leads that can actually be mailed float to
 * the top and the chosen column is a tiebreaker within each bucket. Backed by
 * a generated column with an index (migration 034), so it is cheap.
 *
 * Contact-discovery columns are the deliberate exception. "Show me the Snov
 * contacts" means exactly that; keeping the verification pre-sort would rank
 * by primary-email quality first and bury the handful of rows that have a
 * discovered contact behind hundreds that don't.
 */

/** Columns a caller may order by. Anything else falls back to `created_at`. */
export const ALLOWED_SORT_COLUMNS = new Set([
  'company_name', 'star_rating', 'outreach_status',
  'country', 'category', 'primary_email', 'trustpilot_email', 'website_email',
  'created_at', 'scraped_at',
  'snov_email', 'apollo_email',
]);

/** Sorting these must put rows that HAVE a value first, not nulls. */
export const EMAIL_SORT_COLUMNS = new Set([
  'primary_email', 'trustpilot_email', 'website_email',
  'snov_email', 'apollo_email',
]);

/** Per-provider contact columns — these bypass the verification pre-sort. */
export const DISCOVERY_SORT_COLUMNS = new Set(['snov_email', 'apollo_email']);

export interface SortStep {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

export function buildSortPlan(
  sortBy: string | undefined,
  sortDir: 'asc' | 'desc' | undefined,
): SortStep[] {
  const column = sortBy && ALLOWED_SORT_COLUMNS.has(sortBy) ? sortBy : 'created_at';
  const ascending = sortDir === 'asc';
  const nullsFirst = EMAIL_SORT_COLUMNS.has(column) ? false : undefined;

  const step: SortStep = { column, ascending, nullsFirst };
  if (DISCOVERY_SORT_COLUMNS.has(column)) return [step];

  return [{ column: 'verification_rank', ascending: true, nullsFirst: false }, step];
}

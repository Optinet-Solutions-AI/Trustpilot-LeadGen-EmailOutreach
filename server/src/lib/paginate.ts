/**
 * Read a whole table, not the first thousand rows of it.
 *
 * PostgREST caps every response at 1,000 rows and reports nothing: a
 * `.limit(20000)` returns exactly 1,000 rows with no error and no truncation
 * flag, so the caller believes it has everything. Measured 2026-09-14, that
 * silently broke the send calendar, the shared day-load and the queue
 * re-pacer — the re-pacer "re-paced" 11 rows of 692 and reported success.
 *
 * Any read that must be complete to be correct goes through here:
 *
 *   const rows = await selectAllRows((from, to) =>
 *     supabase.from('campaign_leads').select('id, status')
 *       .eq('channel', 'email').order('id').range(from, to));
 *
 * Give the query a stable `.order(...)`. Without one, PostgREST is free to
 * return pages in different orders and the walk can repeat or skip rows.
 */

export interface PostgrestPage<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export interface SelectAllOptions {
  /** Rows per request. PostgREST will not exceed its own cap regardless. */
  pageSize?: number;
  /**
   * Refuse to walk past this many rows. A server that always returns a full
   * page would otherwise loop until the request timed out.
   */
  maxRows?: number;
}

export async function selectAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PostgrestPage<T>>,
  { pageSize = 1000, maxRows = 100_000 }: SelectAllOptions = {},
): Promise<T[]> {
  const rows: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    // A partial list is more dangerous than no list: it reads as authoritative
    // and the caller plans real sends against it.
    if (error) throw new Error(error.message);

    const page = data ?? [];
    rows.push(...page);

    if (page.length < pageSize) return rows;
    if (rows.length > maxRows) {
      throw new Error(`selectAllRows: refusing to read more than ${maxRows} rows`);
    }
  }
}

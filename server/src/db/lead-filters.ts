/**
 * Distinct country/category options for every filter dropdown in the app.
 *
 * Two rules this module exists to enforce:
 *
 * 1. Read the WHOLE table. PostgREST caps an unbounded select at 1,000 rows,
 *    so the previous single-select version computed "distinct" from an
 *    arbitrary slice — a newly scraped category could be absent from every
 *    dropdown with nothing to show it had been dropped.
 * 2. Serve two scopes, not one. The Lead Matrix lists every lead, so it needs
 *    every category; the campaign wizard only ever mails, so offering it a
 *    category whose leads have no addresses just produces an empty recipient
 *    list.
 */

export interface FilterRow {
  country: string | null;
  category: string | null;
  primary_email: string | null;
}

export interface FilterOptions {
  /** Everything present on any lead — what the Lead Matrix filters on. */
  countries: string[];
  categories: string[];
  /** Restricted to leads that actually carry an address — for the wizard. */
  emailableCountries: string[];
  emailableCategories: string[];
}

const clean = (value: string | null): string | null => {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
};

export function collectFilterOptions(rows: Iterable<FilterRow>): FilterOptions {
  const countries = new Set<string>();
  const categories = new Set<string>();
  const emailableCountries = new Set<string>();
  const emailableCategories = new Set<string>();

  for (const r of rows) {
    const country = clean(r.country);
    const category = clean(r.category);
    const mailable = clean(r.primary_email) !== null;

    if (country) {
      countries.add(country);
      if (mailable) emailableCountries.add(country);
    }
    if (category) {
      categories.add(category);
      if (mailable) emailableCategories.add(category);
    }
  }

  const sorted = (s: Set<string>) => [...s].sort();
  return {
    countries: sorted(countries),
    categories: sorted(categories),
    emailableCountries: sorted(emailableCountries),
    emailableCategories: sorted(emailableCategories),
  };
}

/** One page of rows for the window [from, to] inclusive, PostgREST-style. */
export type FilterRowPager = (from: number, to: number) => Promise<FilterRow[]>;

/**
 * Page through the whole table. Stops on the first short page, which is the
 * only reliable end-of-data signal PostgREST gives us without a count query.
 */
export async function fetchAllFilterRows(
  page: FilterRowPager,
  pageSize = 1000,
): Promise<FilterRow[]> {
  const all: FilterRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const rows = await page(from, from + pageSize - 1);
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
}

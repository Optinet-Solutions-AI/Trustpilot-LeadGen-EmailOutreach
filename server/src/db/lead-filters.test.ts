/**
 * GET /api/leads/filters feeds every category dropdown in the app.
 *
 * It used to be a single unbounded select, which PostgREST caps at 1,000 rows,
 * so the "distinct" lists were computed from an arbitrary slice of the book —
 * a freshly scraped category could simply never appear. Same 1,000-row trap
 * that silently dropped the last-seeded TripAdvisor countries.
 *
 * It also filtered to leads that already had an email, which hid a new
 * category from the Lead Matrix until enrichment had found an address for it.
 */
import { describe, it, expect } from 'vitest';
import { collectFilterOptions, fetchAllFilterRows } from './lead-filters.js';

const row = (country: string | null, category: string | null, email: string | null = null) =>
  ({ country, category, primary_email: email });

describe('collectFilterOptions', () => {
  it('returns each distinct value once, sorted', () => {
    const o = collectFilterOptions([
      row('GB', 'casino'), row('BR', 'casino'), row('GB', 'bookmaker'),
    ]);
    expect(o.countries).toEqual(['BR', 'GB']);
    expect(o.categories).toEqual(['bookmaker', 'casino']);
  });

  it('ignores nulls and blanks rather than emitting empty options', () => {
    const o = collectFilterOptions([
      row(null, null), row('', ''), row('  ', '  '), row('GB', 'casino'),
    ]);
    expect(o.countries).toEqual(['GB']);
    expect(o.categories).toEqual(['casino']);
  });

  it('lists a category that exists only on leads with no email', () => {
    // The Lead Matrix shows these leads, so it must be able to filter to them.
    const o = collectFilterOptions([row('BR', 'br_licensed_betting', null)]);
    expect(o.categories).toContain('br_licensed_betting');
  });

  it('keeps that category OUT of the emailable list the wizard uses', () => {
    const o = collectFilterOptions([row('BR', 'br_licensed_betting', null)]);
    expect(o.emailableCategories).not.toContain('br_licensed_betting');
  });

  it('counts a category as emailable as soon as one lead has an address', () => {
    const o = collectFilterOptions([
      row('BR', 'br_licensed_betting', null),
      row('BR', 'br_licensed_betting', 'ops@example.com'),
    ]);
    expect(o.emailableCategories).toEqual(['br_licensed_betting']);
    expect(o.emailableCountries).toEqual(['BR']);
  });

  it('treats a blank string email as no email', () => {
    const o = collectFilterOptions([row('BR', 'casino', '   ')]);
    expect(o.emailableCategories).toEqual([]);
  });

  it('scopes emailable countries and categories independently of each other', () => {
    const o = collectFilterOptions([
      row('GB', 'casino', 'a@x.com'),
      row('BR', 'bookmaker', null),
    ]);
    expect(o.countries).toEqual(['BR', 'GB']);
    expect(o.emailableCountries).toEqual(['GB']);
    expect(o.emailableCategories).toEqual(['casino']);
  });
});

describe('fetchAllFilterRows', () => {
  it('keeps paging past the 1,000-row cap', async () => {
    const pageOf = (n: number, tag: string) =>
      Array.from({ length: n }, () => row('GB', tag));
    const pages = [pageOf(1000, 'casino'), pageOf(500, 'br_licensed_betting')];
    let calls = 0;

    const rows = await fetchAllFilterRows(async () => pages[calls++] ?? [], 1000);

    expect(rows).toHaveLength(1500);
    expect(collectFilterOptions(rows).categories).toContain('br_licensed_betting');
  });

  it('stops on the first short page instead of looping forever', async () => {
    let calls = 0;
    const rows = await fetchAllFilterRows(async () => {
      calls++;
      return Array.from({ length: 10 }, () => row('GB', 'casino'));
    }, 1000);
    expect(calls).toBe(1);
    expect(rows).toHaveLength(10);
  });

  it('asks for the correct row window each time', async () => {
    const seen: Array<[number, number]> = [];
    await fetchAllFilterRows(async (from, to) => {
      seen.push([from, to]);
      return seen.length === 1 ? Array.from({ length: 2 }, () => row('GB', 'casino')) : [];
    }, 2);
    expect(seen).toEqual([[0, 1], [2, 3]]);
  });

  it('returns nothing when the table is empty', async () => {
    expect(await fetchAllFilterRows(async () => [], 1000)).toEqual([]);
  });
});

/**
 * Lead list ordering.
 *
 * Every query normally sorts by `verification_rank` first, so email quality
 * wins and the chosen column is only a tiebreaker. That is right for the
 * default matrix, but it defeats a contact-discovery sort: asking for "Snov
 * contacts first" would still hand back verified-primary-email leads first
 * and bury the three rows the operator wanted to see.
 */
import { describe, it, expect } from 'vitest';
import { buildSortPlan, DISCOVERY_SORT_COLUMNS } from './lead-sort.js';

describe('buildSortPlan', () => {
  it('puts verification quality first for a normal sort', () => {
    const plan = buildSortPlan('company_name', 'asc');
    expect(plan[0]).toEqual({ column: 'verification_rank', ascending: true, nullsFirst: false });
    expect(plan[1]).toEqual({ column: 'company_name', ascending: true, nullsFirst: undefined });
  });

  it('defaults to created_at descending when no column is given', () => {
    const plan = buildSortPlan(undefined, undefined);
    expect(plan[1].column).toBe('created_at');
    expect(plan[1].ascending).toBe(false);
  });

  it('ignores a column that is not on the allowlist', () => {
    // Guards against ordering by arbitrary caller-supplied SQL.
    expect(buildSortPlan('drop table leads', 'asc')[1].column).toBe('created_at');
  });

  it('sorts emails nulls-last so rows that have one come first', () => {
    const plan = buildSortPlan('primary_email', 'asc');
    expect(plan[1]).toEqual({ column: 'primary_email', ascending: true, nullsFirst: false });
  });

  it('leaves non-email columns with the database default for nulls', () => {
    expect(buildSortPlan('star_rating', 'asc')[1].nullsFirst).toBeUndefined();
  });

  // --- the contact-discovery exception ---

  it.each([...DISCOVERY_SORT_COLUMNS])(
    'drops the verification pre-sort when sorting by %s', (col) => {
      const plan = buildSortPlan(col, 'asc');
      expect(plan.map((s) => s.column)).not.toContain('verification_rank');
      expect(plan[0].column).toBe(col);
    });

  it('puts rows that HAVE a discovered contact first', () => {
    const plan = buildSortPlan('snov_email', 'asc');
    expect(plan[0].nullsFirst).toBe(false);
  });

  it('still honours the requested direction on a discovery column', () => {
    expect(buildSortPlan('snov_email', 'desc')[0].ascending).toBe(false);
  });

  it('treats apollo the same as snov', () => {
    const plan = buildSortPlan('apollo_email', 'asc');
    expect(plan).toEqual([{ column: 'apollo_email', ascending: true, nullsFirst: false }]);
  });
});

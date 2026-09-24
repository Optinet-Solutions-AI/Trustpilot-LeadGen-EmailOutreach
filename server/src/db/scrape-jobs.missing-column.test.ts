import { describe, test, expect, vi } from 'vitest';
import { stripMissingColumns, isMissingColumnError } from './scrape-jobs.js';

/**
 * A job update must survive a column the database does not have yet.
 *
 * Migration 066 adds `cost_usd` / `cost_detail` to scrape_jobs, and the code
 * that writes them ships to Cloud Run the moment main moves — but a migration
 * is applied by hand in the Supabase SQL editor. So there is always a window
 * where the deployed code writes a column that does not exist.
 *
 * PostgREST answers that with `42703 column ... does not exist`, and because
 * `updateJob` throws on error, the WHOLE completion update would fail: a
 * finished scrape would never be marked completed, its lead counts would never
 * be written, and the job would sit "running" until the stale sweep requeued
 * it. Losing a cost figure is trivial; losing the job's result is not.
 *
 * So an unknown column is dropped and the update retried without it.
 */

describe('isMissingColumnError', () => {
  test('recognises PostgREST saying the column is not there', () => {
    expect(isMissingColumnError(
      new Error("column scrape_jobs.cost_usd does not exist"))).toBe(true);
    expect(isMissingColumnError({ code: '42703' })).toBe(true);
  });

  test('does not mistake other failures for it', () => {
    // A real fault must still surface, or we would silently drop data on
    // every kind of error rather than just this one.
    for (const other of [
      new Error('duplicate key value violates unique constraint'),
      new Error('permission denied for table scrape_jobs'),
      new Error('network timeout'),
      { code: '23505' },
      null,
      undefined,
    ]) {
      expect(isMissingColumnError(other), String(other)).toBe(false);
    }
  });
});

describe('stripMissingColumns', () => {
  test('removes exactly the column the database complained about', () => {
    const patch = { status: 'completed', total_scraped: 4, cost_usd: 0.34 };
    expect(stripMissingColumns(patch, new Error('column scrape_jobs.cost_usd does not exist')))
      .toEqual({ status: 'completed', total_scraped: 4 });
  });

  test('handles the unqualified spelling too', () => {
    expect(stripMissingColumns({ a: 1, cost_detail: {} },
      new Error(`column "cost_detail" of relation "scrape_jobs" does not exist`)))
      .toEqual({ a: 1 });
  });

  test('returns null when it cannot tell which column to drop', () => {
    // Guessing would mean silently discarding a field the caller needed.
    expect(stripMissingColumns({ a: 1 }, new Error('column does not exist'))).toBeNull();
  });

  test('returns null rather than an empty patch', () => {
    // Nothing left to write means there is no retry worth making.
    expect(stripMissingColumns({ cost_usd: 1 },
      new Error('column scrape_jobs.cost_usd does not exist'))).toBeNull();
  });
});

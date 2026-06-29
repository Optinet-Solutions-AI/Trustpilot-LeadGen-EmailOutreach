import { describe, test, expect, vi, afterEach } from 'vitest';

// The module pulls in supabase via getSupabase(); mock it so importing the
// module for the pure gate helper has no side effects.
vi.mock('../lib/supabase.js', () => ({ getSupabase: () => ({ from: vi.fn() }) }));

import { isWarmupSchedulerEnabled } from './warmup-scheduler.js';

const ORIGINAL = process.env.WARMUP_ENABLED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WARMUP_ENABLED;
  else process.env.WARMUP_ENABLED = ORIGINAL;
});

describe('isWarmupSchedulerEnabled', () => {
  test('defaults to true when WARMUP_ENABLED is unset (preserves prod behavior)', () => {
    delete process.env.WARMUP_ENABLED;
    expect(isWarmupSchedulerEnabled()).toBe(true);
  });

  test('returns false when WARMUP_ENABLED=false', () => {
    process.env.WARMUP_ENABLED = 'false';
    expect(isWarmupSchedulerEnabled()).toBe(false);
  });

  test('is case-insensitive for false', () => {
    process.env.WARMUP_ENABLED = 'FALSE';
    expect(isWarmupSchedulerEnabled()).toBe(false);
  });

  test('returns true for any non-false value', () => {
    process.env.WARMUP_ENABLED = 'true';
    expect(isWarmupSchedulerEnabled()).toBe(true);
  });
});

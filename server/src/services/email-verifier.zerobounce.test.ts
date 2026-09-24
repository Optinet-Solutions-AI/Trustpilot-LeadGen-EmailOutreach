import { describe, it, expect } from 'vitest';
import { mapBatchResponse } from './email-verifier.zerobounce.js';

const verdict = (address: string, status = 'valid', sub_status = '') => ({
  address, status, sub_status,
} as never);

describe('mapBatchResponse', () => {
  it('throws with the ZB error text when a chunk comes back with no verdicts', () => {
    // The real-world shape behind the 2026-09-03 silent degradation: ZB
    // rejected every address in the burst, so `email_batch` was empty and the
    // reason sat in `errors` — which the old code dropped, returning [] and
    // letting the validator record NULL as if ZB had never been consulted.
    expect(() => mapBatchResponse(['info@example.com'], {
      email_batch: [],
      errors: [{ error: 'Exceeded maximum requests per second', email_address: 'info@example.com' }],
    })).toThrowError(/Exceeded maximum requests per second/);
  });

  it('throws even when ZB reports no error at all but returns nothing', () => {
    expect(() => mapBatchResponse(['info@example.com'], { email_batch: [] }))
      .toThrowError(/no verdict/i);
  });

  it('returns verdicts and keeps partial results when only some addresses error', () => {
    const out = mapBatchResponse(['a@x.com', 'b@x.com'], {
      email_batch: [verdict('a@x.com', 'valid')],
      errors: [{ error: 'rate limited', email_address: 'b@x.com' }],
    });
    expect(out).toEqual([{ email: 'a@x.com', status: 'valid' }]);
  });

  it('maps a role-based do_not_mail to catch-all, not invalid', () => {
    const out = mapBatchResponse(['info@x.com'], {
      email_batch: [verdict('info@x.com', 'do_not_mail', 'role_based')],
    });
    expect(out).toEqual([{ email: 'info@x.com', status: 'catch-all' }]);
  });
});

/**
 * Route test for the manual account-picker addition to POST /api/leads/:id/browse.
 *
 * Placed flat next to the module under test (leads.ts) to match this repo's
 * established convention for route-level tests — see
 * server/src/routes/social-accounts-onboard.test.ts, the first supertest-based
 * route test in the repo. Only the accountId/geo-guard branch is covered here;
 * the pre-existing auto-pick behavior is already covered by
 * server/src/__tests__/lead-browse.test.ts and
 * server/src/services/lead-account-resolver.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db/social-connect-requests.js', () => ({
  enqueueBrowseSession: vi.fn(async () => ({
    id: 'acct-gb',
    connect_session_id: 'sess-1',
    connect_status: 'requested',
  })),
  AccountInUseError: class AccountInUseError extends Error {},
}));

vi.mock('../services/lead-account-resolver.js', () => ({
  resolveLeadAccount: vi.fn(),
  listActiveAccountsForLead: vi.fn(),
  validateAccountForLead: vi.fn(async (accountId: string, _leadId: string) => {
    if (accountId === 'acct-us') {
      return { ok: false, reason: "Chosen account is not an active Facebook account for this lead's country (GB)" };
    }
    return { ok: true, account_id: accountId, country: 'GB' };
  }),
}));

import router from './leads.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/leads', router);
  return a;
}

describe('POST /api/leads/:id/browse — accountId branch', () => {
  it('400s when the chosen accountId fails the geo guard', async () => {
    const res = await request(app())
      .post('/api/leads/lead-1/browse')
      .send({ requestedBy: 'operator@example.com', accountId: 'acct-us' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/GB/);
  });

  it('enqueues a browse session for a valid same-country accountId', async () => {
    const res = await request(app())
      .post('/api/leads/lead-1/browse')
      .send({ requestedBy: 'operator@example.com', accountId: 'acct-gb' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.account_id).toBe('acct-gb');
  });
});

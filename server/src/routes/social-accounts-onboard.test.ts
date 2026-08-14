/**
 * Route tests for the FB account-onboarding wizard endpoints added to
 * social-accounts.ts: POST /onboard, GET /countries, POST /:id/onboard-complete.
 *
 * This is the first supertest-based route test in the repo (existing tests
 * under src/__tests__/ and src/db/*.test.ts exercise service/DB functions
 * directly rather than spinning up an Express app). Placed flat next to the
 * module under test — server/src/routes/social-accounts-onboard.test.ts —
 * to match this repo's established convention of flat, module-adjacent test
 * files (e.g. server/src/db/social-accounts-countries.test.ts) rather than
 * the brief's __tests__/ subdirectory, since no routes/__tests__ dir exists.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db/social-connect-requests.js', () => ({
  enqueueConnectRequest: vi.fn(),
  getConnectRequestStatus: vi.fn(),
  enqueueBrowseSession: vi.fn(),
  endBrowseSession: vi.fn(),
  AccountInUseError: class AccountInUseError extends Error {},
  enqueueOnboardRequest: vi.fn(async () => ({ accountId: 'acc-1', sessionId: 's-1' })),
  activateOnboardedAccount: vi.fn(async () => {}),
}));
vi.mock('../db/social-accounts-countries.js', () => ({
  listActiveCountries: vi.fn(async () => ['GB', 'US']),
}));

import router from './social-accounts.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/social-accounts', router);
  return a;
}

describe('onboarding routes', () => {
  it('POST /onboard requires a country', async () => {
    const res = await request(app()).post('/api/social-accounts/onboard').send({});
    expect(res.status).toBe(400);
  });

  it('POST /onboard returns the new account id', async () => {
    const res = await request(app()).post('/api/social-accounts/onboard').send({ country: 'GB' });
    expect(res.status).toBe(200);
    expect(res.body.data.accountId).toBe('acc-1');
  });

  it('GET /countries returns the active markets', async () => {
    const res = await request(app()).get('/api/social-accounts/countries');
    expect(res.status).toBe(200);
    expect(res.body.data.countries).toEqual(['GB', 'US']);
  });

  it('POST /:id/onboard-complete activates the account', async () => {
    const res = await request(app()).post('/api/social-accounts/acc-1/onboard-complete');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

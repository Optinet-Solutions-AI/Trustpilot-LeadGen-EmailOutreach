import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScrapingBeeCredits, scrapingBeeExhaustedMessage } from './scrapingbee-credits.js';

function mockUsage(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

describe('getScrapingBeeCredits', () => {
  beforeEach(() => { process.env.SCRAPINGBEE_API_KEY = 'test-key'; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SCRAPINGBEE_API_KEY; });

  it('reports exhausted when used exceeds the allowance (the 2026-09-24 ES case)', async () => {
    mockUsage(200, { max_api_credit: 1000, used_api_credit: 101595 });
    const c = await getScrapingBeeCredits({ fresh: true });
    expect(c.status).toBe('exhausted');
    expect(c.remaining).toBe(0);
    expect(scrapingBeeExhaustedMessage(c)).toMatch(/out of credits \(101,595 of 1,000 credits used\).*top up/);
  });

  it('reports exhausted when fewer credits remain than one stealth page', async () => {
    mockUsage(200, { max_api_credit: 1000, used_api_credit: 950 });
    expect((await getScrapingBeeCredits({ fresh: true })).status).toBe('exhausted');
  });

  it('reports ok with enough credits left', async () => {
    mockUsage(200, { max_api_credit: 250000, used_api_credit: 1000 });
    const c = await getScrapingBeeCredits({ fresh: true });
    expect(c.status).toBe('ok');
    expect(c.remaining).toBe(249000);
  });

  it('treats a rejected key as exhausted', async () => {
    mockUsage(401, { message: 'Invalid api key' });
    expect((await getScrapingBeeCredits({ fresh: true })).status).toBe('exhausted');
  });

  it('fails open on a server error, a network error, or no key', async () => {
    mockUsage(500, {});
    expect((await getScrapingBeeCredits({ fresh: true })).status).toBe('unknown');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect((await getScrapingBeeCredits({ fresh: true })).status).toBe('unknown');

    delete process.env.SCRAPINGBEE_API_KEY;
    expect((await getScrapingBeeCredits({ fresh: true })).status).toBe('unknown');
  });
});

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { openaiEnrichEnabled, maxCallsPerRun, tier10OpenAiLookup } from './tier10-openai.js';

/**
 * Tier 10 searches rather than fetching, which makes it the only tier that
 * can help when a site is unreachable, gone, or never published an address.
 *
 * Measured 2026-09-25 on leads with NO email after the full ladder: 6 of 10,
 * across Trustpilot, Yelp and TripAdvisor, at $0.079 per email found. The
 * ladder it sits behind is mostly dead — ScrapingBee is a free tier 100x over
 * its allowance, SCRAPFLY_API_KEY is unset, Hunter's free tier is 50 calls a
 * month — so for most leads this is the only tier left.
 *
 * Searching is also how it can be wrong in a way the others cannot: it can
 * return a plausible address for a DIFFERENT business. Hence off by default,
 * capped per run, normalised on the way out, and ZeroBounce before anything
 * is sent.
 */

const ENV_KEYS = [
  'OPENAI_API_KEY', 'ENRICH_OPENAI_ENABLED', 'ENRICH_OPENAI_MAX_PER_RUN', 'ENRICH_OPENAI_MODEL',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe('openaiEnrichEnabled', () => {
  test('is OFF unless explicitly switched on', () => {
    // 8,314 email-less leads at $0.047 is ~$390. That is a decision, not a
    // default that should fire because a key happens to be present.
    process.env.OPENAI_API_KEY = 'sk-proj-x';
    delete process.env.ENRICH_OPENAI_ENABLED;
    expect(openaiEnrichEnabled()).toBe(false);
  });

  test('stays off without a key even when switched on', () => {
    process.env.ENRICH_OPENAI_ENABLED = 'true';
    delete process.env.OPENAI_API_KEY;
    expect(openaiEnrichEnabled()).toBe(false);
  });

  test('is on when both are set', () => {
    process.env.ENRICH_OPENAI_ENABLED = 'true';
    process.env.OPENAI_API_KEY = 'sk-proj-x';
    expect(openaiEnrichEnabled()).toBe(true);
  });
});

describe('maxCallsPerRun', () => {
  test('unset means no ceiling', () => {
    delete process.env.ENRICH_OPENAI_MAX_PER_RUN;
    expect(maxCallsPerRun()).toBe(0);
  });

  test('reads a positive ceiling', () => {
    process.env.ENRICH_OPENAI_MAX_PER_RUN = '200';
    expect(maxCallsPerRun()).toBe(200);
  });

  test('rejects nonsense rather than capping at something arbitrary', () => {
    for (const bad of ['-5', 'lots', '0', '']) {
      process.env.ENRICH_OPENAI_MAX_PER_RUN = bad;
      expect(maxCallsPerRun(), bad).toBe(0);
    }
  });
});

describe('tier10OpenAiLookup', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-proj-test';
    process.env.ENRICH_OPENAI_ENABLED = 'true';
  });

  const reply = (email: unknown, confidence = 'high') => ({
    ok: true,
    json: async () => ({
      usage: { input_tokens: 9000, output_tokens: 120 },
      output: [{
        content: [{ type: 'output_text', text: JSON.stringify({ email, confidence }) }],
      }],
    }),
  });

  test('returns a clean address and what the call cost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('info@therevolutionhotel.com')));
    const got = await tier10OpenAiLookup({ companyName: 'The Revolution Hotel' });
    expect(got.email).toBe('info@therevolutionhotel.com');
    expect(got.usd).toBeGreaterThan(0);
    expect(got.confidence).toBe('high');
  });

  test('repairs the Unicode hyphen a model types', async () => {
    // One in eight measured addresses arrived this way: visually identical to
    // ASCII, completely undeliverable.
    vi.stubGlobal('fetch', vi.fn(async () => reply('info@hotel‑hahn.de')));
    expect((await tier10OpenAiLookup({ companyName: 'Hansa Hotel' })).email)
      .toBe('info@hotel-hahn.de');
  });

  test('rejects a placeholder the model reaches for when it found nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('info@example.com')));
    expect((await tier10OpenAiLookup({ companyName: 'Some Business' })).email).toBeNull();
  });

  test('accepts an honest null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(null)));
    const got = await tier10OpenAiLookup({ companyName: 'Spoon Bar & Grill' });
    expect(got.email).toBeNull();
    expect(got.usd).toBeGreaterThan(0); // the call still cost money
  });

  test('refuses to search with no identity at all', async () => {
    // A bare domain with no name invites an address for whoever else uses
    // that word — and costs money to get it wrong.
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const got = await tier10OpenAiLookup({ companyName: '', websiteUrl: '' });
    expect(got.error).toBe('no_identity');
    expect(got.usd).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a website alone is enough to search on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('info@vangogh.ro')));
    expect((await tier10OpenAiLookup({ websiteUrl: 'https://vangogh.ro' })).email)
      .toBe('info@vangogh.ro');
  });

  test('reports an API failure rather than a silent empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 429, text: async () => 'rate limited',
    })));
    const got = await tier10OpenAiLookup({ companyName: 'X' });
    expect(got.email).toBeNull();
    expect(got.error).toContain('429');
    expect(got.usd).toBe(0);
  });

  test('survives an unparseable reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ usage: {}, output: [{ content: [{ type: 'output_text', text: 'no idea' }] }] }),
    })));
    expect((await tier10OpenAiLookup({ companyName: 'X' })).email).toBeNull();
  });

  test('never throws — an enrichment tier must not fail the lead', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    const got = await tier10OpenAiLookup({ companyName: 'X' });
    expect(got.email).toBeNull();
    expect(got.error).toContain('socket hang up');
  });
});

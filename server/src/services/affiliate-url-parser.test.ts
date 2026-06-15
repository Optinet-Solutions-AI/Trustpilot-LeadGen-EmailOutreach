import { describe, it, expect } from 'vitest';
import { parseTrustpilotAffiliateUrl, partitionBulkUrls } from './affiliate-url-parser';

describe('parseTrustpilotAffiliateUrl', () => {
  it('derives website, geo, tp_url, and a temp name from a regional URL', () => {
    const r = parseTrustpilotAffiliateUrl('https://de.trustpilot.com/review/onlinecasinoohneoasis.me');
    expect(r).toEqual({
      name: 'Onlinecasinoohneoasis',
      website: 'onlinecasinoohneoasis.me',
      tp_url: 'https://de.trustpilot.com/review/onlinecasinoohneoasis.me',
      geo: ['DE'],
      warning: false,
    });
  });

  it('handles a missing scheme and a trailing slash + query', () => {
    const r = parseTrustpilotAffiliateUrl('au.trustpilot.com/review/payid-casino.net/?foo=1');
    expect(r?.website).toBe('payid-casino.net');
    expect(r?.geo).toEqual(['AU']);
    expect(r?.tp_url).toBe('https://au.trustpilot.com/review/payid-casino.net');
    expect(r?.name).toBe('Payid casino');
  });

  it('strips www. from website for dedup but preserves the literal slug in tp_url', () => {
    const r = parseTrustpilotAffiliateUrl('https://dk.trustpilot.com/review/www.grimme-aelling.dk');
    expect(r?.website).toBe('grimme-aelling.dk');
    // tp_url keeps the exact Trustpilot slug — /review/www.* and /review/* are
    // different profile pages, so we must not strip www. from the link itself.
    expect(r?.tp_url).toBe('https://dk.trustpilot.com/review/www.grimme-aelling.dk');
  });

  it('gives bare and www hosts an empty geo', () => {
    expect(parseTrustpilotAffiliateUrl('https://trustpilot.com/review/foo.com')?.geo).toEqual([]);
    expect(parseTrustpilotAffiliateUrl('https://www.trustpilot.com/review/foo.com')?.geo).toEqual([]);
  });

  it('rejects non-trustpilot and non-review URLs', () => {
    expect(parseTrustpilotAffiliateUrl('https://example.com/review/foo.com')).toBeNull();
    expect(parseTrustpilotAffiliateUrl('https://de.trustpilot.com/categories/casino')).toBeNull();
    expect(parseTrustpilotAffiliateUrl('not a url')).toBeNull();
    expect(parseTrustpilotAffiliateUrl('   ')).toBeNull();
  });
});

describe('partitionBulkUrls', () => {
  it('splits into toInsert / skipped(dup) / invalid and dedupes within the paste', () => {
    const text = [
      'https://de.trustpilot.com/review/new-one.com',
      'https://de.trustpilot.com/review/already.com',      // exists in DB
      'https://au.trustpilot.com/review/new-one.com',      // dup of line 1 by website
      'garbage line',
      '',
    ].join('\n');
    const existing = [{ website: 'already.com', tp_url: null }];
    const out = partitionBulkUrls(text, existing);
    expect(out.toInsert.map((r) => r.website)).toEqual(['new-one.com']);
    expect(out.skipped).toEqual(['already.com', 'new-one.com']);
    expect(out.invalid).toEqual(['garbage line']);
  });
});

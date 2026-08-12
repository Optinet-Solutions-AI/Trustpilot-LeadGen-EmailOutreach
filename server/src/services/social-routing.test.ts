import { describe, it, expect } from 'vitest';
import {
  shouldRefuseSocialOnLinux,
  socialProfileEnv,
  facebookJobUsesBrowser,
  isFacebookConsumerJob,
  scrapeJobUsesBrowser,
  defaultFbConsumerQuery,
} from './social-routing.js';

describe('shouldRefuseSocialOnLinux', () => {
  it('refuses browser-driven facebook and instagram on linux', () => {
    expect(shouldRefuseSocialOnLinux('facebook', 'linux', { usesBrowser: true })).toBe(true);
    expect(shouldRefuseSocialOnLinux('instagram', 'linux', { usesBrowser: true })).toBe(true);
  });
  it('defaults to refusing when the caller says nothing about the browser', () => {
    expect(shouldRefuseSocialOnLinux('facebook', 'linux')).toBe(true);
  });
  it('allows a browserless facebook job on linux', () => {
    expect(shouldRefuseSocialOnLinux('facebook', 'linux', { usesBrowser: false })).toBe(false);
  });
  it('allows review platforms on linux and any platform on win32', () => {
    expect(shouldRefuseSocialOnLinux('yelp', 'linux', { usesBrowser: true })).toBe(false);
    expect(shouldRefuseSocialOnLinux('instagram', 'win32', { usesBrowser: true })).toBe(false);
  });
});

describe('facebookJobUsesBrowser', () => {
  it('is false only when discovery is apify AND enrichment is stub', () => {
    expect(facebookJobUsesBrowser({ FB_DISCOVERY: 'apify', FB_ENRICH: 'stub' })).toBe(false);
    expect(facebookJobUsesBrowser({ FB_DISCOVERY: 'browser', FB_ENRICH: 'stub' })).toBe(true);
    expect(facebookJobUsesBrowser({ FB_DISCOVERY: 'apify', FB_ENRICH: 'browser' })).toBe(true);
  });
  it('treats the defaults (both unset) as browserless', () => {
    expect(facebookJobUsesBrowser({})).toBe(false);
  });
  it('treats blank env values as unset, matching Python `or` semantics', () => {
    expect(facebookJobUsesBrowser({ FB_DISCOVERY: '', FB_ENRICH: '' })).toBe(false);
  });
  it('tolerates surrounding whitespace, matching Python `.strip()`', () => {
    expect(facebookJobUsesBrowser({ FB_DISCOVERY: ' apify ', FB_ENRICH: ' stub ' })).toBe(false);
  });
  it('still reports browser-driven for an unrecognised value (safe direction)', () => {
    expect(facebookJobUsesBrowser({ FB_DISCOVERY: 'apfiy' })).toBe(true);
  });
});

describe('isFacebookConsumerJob', () => {
  it('is true for an explicit consumers lead_type', () => {
    expect(isFacebookConsumerJob({ lead_type: 'consumers' })).toBe(true);
    expect(isFacebookConsumerJob({ lead_type: ' Consumers ' })).toBe(true);
  });
  it('treats an absent or blank lead_type as consumers, matching facebook.py', () => {
    // facebook.py reads `(filters.get('lead_type') or 'consumers')` in both
    // scrape_listing and search_posts, so absent/blank IS consumer mode there.
    expect(isFacebookConsumerJob({})).toBe(true);
    expect(isFacebookConsumerJob({ lead_type: '' })).toBe(true);
    expect(isFacebookConsumerJob({ lead_type: null })).toBe(true);
    expect(isFacebookConsumerJob(undefined)).toBe(true);
  });
  it('is false for businesses and for any other explicit value', () => {
    expect(isFacebookConsumerJob({ lead_type: 'businesses' })).toBe(false);
    expect(isFacebookConsumerJob({ lead_type: 'pages' })).toBe(false);
    expect(isFacebookConsumerJob({ lead_type: 7 })).toBe(false);
  });
});

describe('scrapeJobUsesBrowser', () => {
  const browserless = { FB_DISCOVERY: 'apify', FB_ENRICH: 'stub' };

  it('reports browser-driven for every non-facebook platform', () => {
    expect(scrapeJobUsesBrowser('instagram', { lead_type: 'consumers' }, browserless)).toBe(true);
    expect(scrapeJobUsesBrowser('yelp', {}, browserless)).toBe(true);
  });
  it('reports browser-driven for facebook BUSINESS mode regardless of FB_DISCOVERY/FB_ENRICH', () => {
    // Business mode dispatches --action list/enrich → _sync_scrape_pages /
    // _sync_enrich_pages, which claim an account and open a session
    // unconditionally; the discovery/enrich switches govern consumer mode only.
    expect(scrapeJobUsesBrowser('facebook', { lead_type: 'businesses' }, browserless)).toBe(true);
  });
  it('reports browserless for facebook consumer mode on the apify+stub config', () => {
    expect(scrapeJobUsesBrowser('facebook', { lead_type: 'consumers' }, browserless)).toBe(false);
  });
  it('treats an absent lead_type as consumer mode (browserless on apify+stub)', () => {
    expect(scrapeJobUsesBrowser('facebook', {}, browserless)).toBe(false);
    expect(scrapeJobUsesBrowser('facebook', undefined, browserless)).toBe(false);
  });
  it('reports browser-driven for facebook consumer mode when either switch is browser', () => {
    expect(scrapeJobUsesBrowser('facebook', { lead_type: 'consumers' }, { FB_DISCOVERY: 'browser' })).toBe(true);
    expect(scrapeJobUsesBrowser('facebook', { lead_type: 'consumers' }, { FB_ENRICH: 'browser' })).toBe(true);
  });
});

describe('linux refusal composed with scrapeJobUsesBrowser', () => {
  const browserless = { FB_DISCOVERY: 'apify', FB_ENRICH: 'stub' };
  const refuses = (platform: string, filters: unknown, env: Record<string, string | undefined>) =>
    shouldRefuseSocialOnLinux(platform, 'linux', { usesBrowser: scrapeJobUsesBrowser(platform, filters, env) });

  it('still refuses a facebook BUSINESS-mode job on linux', () => {
    expect(refuses('facebook', { lead_type: 'businesses' }, browserless)).toBe(true);
  });
  it('allows a browserless facebook CONSUMER-mode job on linux', () => {
    expect(refuses('facebook', { lead_type: 'consumers' }, browserless)).toBe(false);
  });
  it('allows a browserless facebook job with an absent lead_type on linux', () => {
    expect(refuses('facebook', {}, browserless)).toBe(false);
  });
  it('still refuses instagram on linux', () => {
    expect(refuses('instagram', { lead_type: 'consumers' }, browserless)).toBe(true);
  });
});

describe('defaultFbConsumerQuery', () => {
  it('builds the measured-good intent phrasing and leaves geography out', () => {
    // 2026-08-03 live measurement: "looking for a plumber in Manchester"
    // returned 0/20 usable asks; "need a plumber recommendation" returned
    // genuine consumer asks.
    expect(defaultFbConsumerQuery('plumber', 'Manchester')).toBe('need a plumber recommendation');
    expect(defaultFbConsumerQuery('plumber')).toBe('need a plumber recommendation');
  });
  it('never emits the geo-stuffed "looking for" shape', () => {
    expect(defaultFbConsumerQuery('dentist', 'London')).not.toContain('looking for');
    expect(defaultFbConsumerQuery('dentist', 'London')).not.toContain('London');
  });
  it('collapses whitespace and trims', () => {
    expect(defaultFbConsumerQuery('  emergency   plumber ', ' London ')).toBe(
      'need a emergency plumber recommendation',
    );
  });
  it('falls back to the bare location when there is no niche', () => {
    // Better than "need a recommendation", which matches nothing useful;
    // run.py still needs a non-empty query for --action search-posts.
    expect(defaultFbConsumerQuery('', 'Manchester')).toBe('Manchester');
  });
  it('returns empty when it has nothing to work with', () => {
    expect(defaultFbConsumerQuery('', '')).toBe('');
    expect(defaultFbConsumerQuery()).toBe('');
  });
});

describe('socialProfileEnv', () => {
  it('maps facebook/instagram to their per-account profile dirs', () => {
    expect(socialProfileEnv('facebook', 'abc')).toEqual({ FB_PROFILE_DIR: 'C:\\fb-profiles\\abc' });
    expect(socialProfileEnv('instagram', 'abc')).toEqual({ IG_PROFILE_DIR: 'C:\\ig-profiles\\abc' });
  });
  it('returns empty when no social account id', () => {
    expect(socialProfileEnv('facebook', undefined)).toEqual({});
    expect(socialProfileEnv('yelp', 'abc')).toEqual({});
  });
});

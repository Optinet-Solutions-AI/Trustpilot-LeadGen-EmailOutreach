import { describe, it, expect } from 'vitest';
import { shouldRefuseSocialOnLinux, socialProfileEnv, facebookJobUsesBrowser } from './social-routing.js';

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

import { describe, it, expect } from 'vitest';
import { shouldRefuseSocialOnLinux, socialProfileEnv } from './social-routing.js';

describe('shouldRefuseSocialOnLinux', () => {
  it('refuses facebook and instagram on linux', () => {
    expect(shouldRefuseSocialOnLinux('facebook', 'linux')).toBe(true);
    expect(shouldRefuseSocialOnLinux('instagram', 'linux')).toBe(true);
  });
  it('allows review platforms on linux and any platform on win32', () => {
    expect(shouldRefuseSocialOnLinux('yelp', 'linux')).toBe(false);
    expect(shouldRefuseSocialOnLinux('instagram', 'win32')).toBe(false);
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

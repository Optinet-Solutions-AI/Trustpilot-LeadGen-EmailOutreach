import { describe, it, expect } from 'vitest';
import { resolveLocale, localizeText } from './locale';

describe('resolveLocale', () => {
  it('maps AU to commonwealth + AUD', () => {
    expect(resolveLocale('AU')).toEqual({ variant: 'commonwealth', currencyCode: 'AUD', currencySymbol: 'A$', signoff: 'Cheers' });
  });
  it('maps NZ to commonwealth + NZD', () => {
    expect(resolveLocale('NZ')).toEqual({ variant: 'commonwealth', currencyCode: 'NZD', currencySymbol: 'NZ$', signoff: 'Cheers' });
  });
  it('maps US / unknown / undefined to the us default', () => {
    const us = { variant: 'us', currencyCode: 'USD', currencySymbol: '$', signoff: 'Best regards' };
    expect(resolveLocale('US')).toEqual(us);
    expect(resolveLocale('ZZ')).toEqual(us);
    expect(resolveLocale(undefined)).toEqual(us);
  });
  it('is case-insensitive on the country code', () => {
    expect(resolveLocale('au').variant).toBe('commonwealth');
  });
});

describe('localizeText (commonwealth)', () => {
  it('converts irregular spellings', () => {
    expect(localizeText('color center catalog favorite defense', 'AU'))
      .toBe('colour centre catalogue favourite defence');
  });
  it('converts -ize / -ization / -yze family', () => {
    expect(localizeText('organize optimization analyze', 'NZ'))
      .toBe('organise optimisation analyse');
  });
  it('preserves case', () => {
    expect(localizeText('Organize ORGANIZE organize', 'AU'))
      .toBe('Organise ORGANISE organise');
  });
  it('applies conservative lexical/phrase swaps', () => {
    expect(localizeText('Call my cell phone, note the zip code, do the math', 'AU'))
      .toBe('Call my mobile, note the postcode, do the maths');
  });
  it('is idempotent', () => {
    const once = localizeText('We organize and optimize your color', 'AU');
    expect(localizeText(once, 'AU')).toBe(once);
  });
  it('does NOT touch non-listed -or words', () => {
    expect(localizeText('the doctor and author', 'AU')).toBe('the doctor and author');
  });
  it('does NOT alter URLs, emails, or HTML tags', () => {
    const html = 'Visit <a href="https://organize.com/color">organize</a> or email info@optimize.io';
    expect(localizeText(html, 'AU'))
      .toBe('Visit <a href="https://organize.com/color">organise</a> or email info@optimize.io');
  });
  it('leaves substrings inside larger words alone', () => {
    expect(localizeText('organizecorp', 'AU')).toBe('organizecorp');
  });
  it('returns text unchanged for the us variant', () => {
    const s = 'We organize and optimize your color center.';
    expect(localizeText(s, 'US')).toBe(s);
    expect(localizeText(s, undefined)).toBe(s);
  });
});

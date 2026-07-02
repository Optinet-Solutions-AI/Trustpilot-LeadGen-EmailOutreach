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

  // Regression: mask/restore previously used " 0 ", " 1 " (space-digit-space)
  // tokens, so a literal digit surrounded by spaces in real copy collided
  // with the restore regex and got replaced with `masks[n]` (undefined).
  it('does not corrupt literal digits in the text (placeholder collision)', () => {
    expect(localizeText('We have 3 locations to organize', 'AU'))
      .toBe('We have 3 locations to organise');
  });

  it('preserves numbers alongside a masked URL', () => {
    expect(localizeText('Save 20 percent — visit https://organize.com now', 'AU'))
      .toBe('Save 20 percent — visit https://organize.com now');
  });

  // Regression: MASK_PATTERNS only covered http(s)/www/email, so a bare
  // domain like "organize.com" was left exposed to the word pass and its
  // matching substring got rewritten (e.g. -> "organise.com").
  it('does not localize bare domains', () => {
    expect(localizeText('Visit organize.com today', 'AU'))
      .toBe('Visit organize.com today');
  });

  it('still localizes ordinary prose with sentence-ending periods', () => {
    expect(localizeText('We optimize. Then we organize.', 'AU'))
      .toBe('We optimise. Then we organise.');
  });

  // Regression: the URL/www/bare-domain mask patterns used trailing
  // char classes like [^\s"'<>]+ that did not exclude the PUA mask
  // sentinels. When a URL/domain sat directly adjacent (no whitespace) to
  // an already-inserted mask token, the later greedy pattern swallowed
  // that token; since restore is a single left-to-right pass, the nested
  // token never came back, leaking a raw sentinel and dropping the
  // adjacent tag/content.
  it('does not swallow an adjacent tag when a URL is immediately followed by its own anchor tag', () => {
    const html = '<a href="https://foo.com">https://foo.com</a>';
    expect(localizeText(html, 'AU')).toBe(html);
  });

  it('does not swallow a <br> tag glued directly to a masked URL', () => {
    expect(localizeText('Visit https://organize.com<br>then organize', 'AU'))
      .toBe('Visit https://organize.com<br>then organise');
  });

  it('does not swallow a tag glued directly to a masked bare www domain', () => {
    expect(localizeText('See www.foo.com<b>organize</b>', 'AU'))
      .toBe('See www.foo.com<b>organise</b>');
  });

  it('never leaks raw mask sentinel characters into the output', () => {
    const out = localizeText('Visit https://organize.com<br>then organize', 'AU');
    expect(out).not.toMatch(/[]/);
  });

  // Spec: "license" (verb) is left alone in Commonwealth English — only
  // "licence" (noun) differs from US spelling, so a blanket map entry
  // would wrongly mangle verb usage.
  it('leaves "license" (verb) unchanged', () => {
    expect(localizeText('we license our software', 'AU')).toBe('we license our software');
  });
});

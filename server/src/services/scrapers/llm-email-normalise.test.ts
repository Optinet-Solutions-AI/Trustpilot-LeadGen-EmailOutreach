import { describe, test, expect } from 'vitest';
import { normaliseDiscoveredEmails } from './llm-email-normalise.js';

/**
 * A language model finds contact emails well but types them like prose.
 *
 * Measured 2026-09-24 over 10 TripAdvisor leads our own enrichment pipeline
 * had failed to get any address for: it found 8, an 80% yield on a tail that
 * had yielded nothing, at $0.046 a lead. But one of the eight came back as
 * `comenzi@restaurant\u2011oscar.ro` — a Unicode non-breaking hyphen instead
 * of an ASCII one. It looks identical on screen, it is not a deliverable
 * address, and it would have gone out and bounced. Another returned two
 * addresses in a single string.
 *
 * So nothing a model produces reaches `leads` unnormalised. This is the gate:
 * repair what is unambiguously typography, split what is a list, and REJECT
 * anything still not a valid address. Rejecting is always correct here —
 * a missing email costs one lead, a bounced one costs sending reputation, and
 * the sending domains are mid-warm-up.
 */
describe('normaliseDiscoveredEmails', () => {
  test('repairs the Unicode dashes a model types instead of a hyphen', () => {
    // U+2011 non-breaking hyphen, U+2010 hyphen, U+2013 en dash.
    expect(normaliseDiscoveredEmails('comenzi@restaurant\u2011oscar.ro')).toEqual(['comenzi@restaurant-oscar.ro']);
    expect(normaliseDiscoveredEmails('a@b\u2010c.com')).toEqual(['a@b-c.com']);
    expect(normaliseDiscoveredEmails('a@b\u2013c.com')).toEqual(['a@b-c.com']);
  });

  test('splits several addresses returned in one string', () => {
    expect(normaliseDiscoveredEmails('rezervari@gasthaus-altepost.ro; office@gasthaus-altepost.ro'))
      .toEqual(['rezervari@gasthaus-altepost.ro', 'office@gasthaus-altepost.ro']);
  });

  test('strips the prose a model wraps around an address', () => {
    expect(normaliseDiscoveredEmails('You can reach them at <info@vangogh.ro>.'))
      .toEqual(['info@vangogh.ro']);
    expect(normaliseDiscoveredEmails('Email: info@seaportboston.com (reception)'))
      .toEqual(['info@seaportboston.com']);
  });

  test('lowercases and de-duplicates', () => {
    expect(normaliseDiscoveredEmails('Info@Vangogh.ro, info@vangogh.ro')).toEqual(['info@vangogh.ro']);
  });

  test('rejects anything that is still not an address', () => {
    for (const bad of ['null', 'not found', 'info@', '@vangogh.ro', 'info@vangogh',
                       'info at vangogh dot ro', '', '   ']) {
      expect(normaliseDiscoveredEmails(bad), bad).toEqual([]);
    }
  });

  test('rejects an address with characters no repair can explain', () => {
    // Cyrillic 'о' inside a domain is a homograph, not a typo. Repairing it
    // would be guessing at which real domain was meant.
    expect(normaliseDiscoveredEmails('info@vangо gh.ro')).toEqual([]);
  });

  test('rejects the placeholder addresses a model falls back to', () => {
    // These are invented, not observed, and they are deliverable-looking.
    for (const bad of ['example@example.com', 'info@example.com', 'your@email.com',
                       'name@domain.com', 'email@address.com']) {
      expect(normaliseDiscoveredEmails(bad), bad).toEqual([]);
    }
  });

  test('accepts the addresses that were genuinely correct', () => {
    expect(normaliseDiscoveredEmails('panoramic@hotelunirea.ro')).toEqual(['panoramic@hotelunirea.ro']);
    expect(normaliseDiscoveredEmails('pizzeriaperla@gmail.com')).toEqual(['pizzeriaperla@gmail.com']);
  });

  test('tolerates a null or undefined answer', () => {
    expect(normaliseDiscoveredEmails(null)).toEqual([]);
    expect(normaliseDiscoveredEmails(undefined)).toEqual([]);
  });
});

/**
 * The actual output of the 2026-09-24 probe, kept verbatim. These ten leads
 * are real TripAdvisor businesses our own enrichment pipeline had failed to
 * find any address for, and this is exactly what the model returned for them.
 */
describe('the real probe output, 10 leads our pipeline could not enrich', () => {
  const PROBE: Array<[string, string | null, string[]]> = [
    ['Panoramic Restaurant',     'panoramic@hotelunirea.ro',        ['panoramic@hotelunirea.ro']],
    ['Restaurant Oscar',         'comenzi@restaurant\u2011oscar.ro', ['comenzi@restaurant-oscar.ro']],
    ['Little Texas',             'receptie@littletexas.ro',         ['receptie@littletexas.ro']],
    ['Grand Cafe Van Gogh',      'info@vangogh.ro',                 ['info@vangogh.ro']],
    ['Seaport Hotel Boston',     'info@seaportboston.com',          ['info@seaportboston.com']],
    ['The Godfrey Hotel Boston', 'info@godfreyhotelboston.com',     ['info@godfreyhotelboston.com']],
    ['Spoon Bar & Grill',        null,                              []],
    ['La Perla',                 'pizzeriaperla@gmail.com',         ['pizzeriaperla@gmail.com']],
    ['Cyrano',                   null,                              []],
    ['Gasthaus Alte Post',       'rezervari@gasthaus-altepost.ro; office@gasthaus-altepost.ro',
      ['rezervari@gasthaus-altepost.ro', 'office@gasthaus-altepost.ro']],
  ];

  test.each(PROBE)('%s', (_name, raw, expected) => {
    expect(normaliseDiscoveredEmails(raw)).toEqual(expected);
  });

  test('turns 8 raw answers into 9 usable addresses, with none left corrupted', () => {
    const all = PROBE.flatMap(([, raw]) => normaliseDiscoveredEmails(raw));
    expect(all).toHaveLength(9);
    expect(all.every((e) => /^[\x20-\x7E]+$/.test(e))).toBe(true);
  });
});

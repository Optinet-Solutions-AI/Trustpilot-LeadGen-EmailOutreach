import { describe, it, expect } from 'vitest';
import { isJunkEmail } from './website-enricher.js';

describe('isJunkEmail', () => {
  it('rejects documentation placeholders', () => {
    // A live lead was carrying example@example.com as its scraped website
    // email (found 2026-09-03) — template boilerplate on the company site,
    // which then went to the verifier as if it were a real contact.
    expect(isJunkEmail('example@example.com')).toBe(true);
    expect(isJunkEmail('you@example.org')).toBe(true);
    expect(isJunkEmail('info@yourdomain.com')).toBe(true);
    expect(isJunkEmail('your-email@domain.com')).toBe(true);
    expect(isJunkEmail('youremail@company.com')).toBe(true);
  });

  it('still rejects the categories it always did', () => {
    expect(isJunkEmail('noreply@realcompany.de')).toBe(true);   // undeliverable prefix
    expect(isJunkEmail('info@gmail.com')).toBe(true);           // free provider
    expect(isJunkEmail('d@a.js')).toBe(true);                   // code fragment
  });

  it('keeps real business addresses', () => {
    expect(isJunkEmail('info@wohlers-sanitaer.de')).toBe(false);
    expect(isJunkEmail('service@boboex.de')).toBe(false);
    expect(isJunkEmail('jane.doe@acme-plumbing.co.uk')).toBe(false);
  });
});

import { describe, test, expect, afterEach } from 'vitest';
import { resolveReplyTo } from './ongage-reply-to.js';

/**
 * Replies to Ongage-sent mail were unreachable. Two reasons, and this covers
 * the first: the reply address defaulted to the sender's own rp.* subdomain,
 * which nothing in the app polls (the IMAP tracker selects auth_type='smtp'
 * with imap_host set, and the Ongage rows are neither).
 *
 * The rp.* domains cannot reliably receive either — each carries two
 * equal-preference MX records, one of which points at a parent domain with no
 * MX at all. So the reply address has to be redirected to a mailbox that is
 * genuinely deliverable AND already polled.
 */

const ORIGINAL = process.env.ONGAGE_REPLY_TO;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ONGAGE_REPLY_TO;
  else process.env.ONGAGE_REPLY_TO = ORIGINAL;
});

describe('resolveReplyTo', () => {
  test('falls back to the sender address when nothing is configured', () => {
    delete process.env.ONGAGE_REPLY_TO;
    expect(resolveReplyTo('grace@rp.rateupdigital.com', null)).toBe('grace@rp.rateupdigital.com');
  });

  test('ONGAGE_REPLY_TO redirects replies to a monitored mailbox', () => {
    process.env.ONGAGE_REPLY_TO = 'ryan@optiratesolutions.org';
    expect(resolveReplyTo('grace@rp.rateupdigital.com', null)).toBe('ryan@optiratesolutions.org');
  });

  test('a per-sender address beats the global one', () => {
    // So each sender can keep its own reply mailbox if that is ever wanted.
    process.env.ONGAGE_REPLY_TO = 'ryan@optiratesolutions.org';
    expect(resolveReplyTo('grace@rp.rateupdigital.com', 'sarah@optiratesolutions.org'))
      .toBe('sarah@optiratesolutions.org');
  });

  test('blank or whitespace config is ignored, not used as an address', () => {
    process.env.ONGAGE_REPLY_TO = '   ';
    expect(resolveReplyTo('grace@rp.rateupdigital.com', null)).toBe('grace@rp.rateupdigital.com');
    expect(resolveReplyTo('grace@rp.rateupdigital.com', '  ')).toBe('grace@rp.rateupdigital.com');
  });

  test('a configured value that is not an address is refused', () => {
    // Sending a malformed Reply-To is worse than sending none: the reply is
    // lost with no bounce anyone will see.
    process.env.ONGAGE_REPLY_TO = 'not-an-address';
    expect(resolveReplyTo('grace@rp.rateupdigital.com', null)).toBe('grace@rp.rateupdigital.com');
  });

  test('surrounding whitespace is trimmed', () => {
    process.env.ONGAGE_REPLY_TO = '  ryan@optiratesolutions.org  ';
    expect(resolveReplyTo('grace@rp.rateupdigital.com', null)).toBe('ryan@optiratesolutions.org');
  });
});

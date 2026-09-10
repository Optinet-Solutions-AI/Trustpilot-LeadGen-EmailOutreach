import { describe, test, expect, afterEach } from 'vitest';
import { resolveReplyFromAddress } from './reply-account.js';

/**
 * Replying from the Inbox returned 400 "Unsupported account auth_type: ongage"
 * for every email sent since the 2026-08-26 cutover, because the dispatch
 * handled only smtp / app_password / gmail_oauth.
 *
 * Ongage cannot carry the reply itself: its transactional endpoint takes a
 * subject and a body and nothing else, so there is no In-Reply-To and no
 * References — the "reply" would arrive as a brand new email. And the Ongage
 * rows hold no SMTP credentials to fall back on.
 *
 * The prospect replied TO the reply-to mailbox, so that mailbox answering is
 * both technically workable and what the recipient expects to see.
 */

const ORIGINAL = process.env.ONGAGE_REPLY_TO;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ONGAGE_REPLY_TO;
  else process.env.ONGAGE_REPLY_TO = ORIGINAL;
});

describe('resolveReplyFromAddress', () => {
  test('an SMTP sender answers as itself', () => {
    expect(resolveReplyFromAddress('smtp', 'james@optiratesolutions.net'))
      .toEqual({ email: 'james@optiratesolutions.net', redirected: false });
  });

  test('an app-password sender answers as itself', () => {
    expect(resolveReplyFromAddress('app_password', 'alex@optiratessolutions.com').redirected).toBe(false);
  });

  test('a Gmail sender answers as itself', () => {
    expect(resolveReplyFromAddress('gmail_oauth', 'someone@gmail.com').redirected).toBe(false);
  });

  test('an Ongage sender hands off to the configured reply mailbox', () => {
    process.env.ONGAGE_REPLY_TO = 'ryan@optiratesolutions.org';
    expect(resolveReplyFromAddress('ongage', 'grace@rp.rateupdigital.com'))
      .toEqual({ email: 'ryan@optiratesolutions.org', redirected: true });
  });

  test('an Ongage sender with no reply mailbox configured cannot answer', () => {
    // Better an explicit null the caller turns into a clear error than sending
    // from an rp.* address that can neither thread nor receive.
    delete process.env.ONGAGE_REPLY_TO;
    expect(resolveReplyFromAddress('ongage', 'grace@rp.rateupdigital.com')).toBeNull();
  });

  test('a blank reply mailbox counts as unconfigured', () => {
    process.env.ONGAGE_REPLY_TO = '   ';
    expect(resolveReplyFromAddress('ongage', 'grace@rp.rateupdigital.com')).toBeNull();
  });

  test('an unknown auth_type is refused rather than guessed at', () => {
    expect(resolveReplyFromAddress('carrier_pigeon', 'a@b.com')).toBeNull();
  });
});

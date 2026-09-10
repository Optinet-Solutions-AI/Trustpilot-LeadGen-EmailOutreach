import { describe, test, expect } from 'vitest';
import { isPollableForReplies, type PollableAccount } from './pollable-accounts.js';

/**
 * The reply poller selected `auth_type='smtp'`, which quietly meant that any
 * mailbox sending through a provider API could never be read — including the
 * three Ongage senders that all current outreach goes out from. Replies were
 * arriving in those mailboxes the whole time; nothing was looking.
 *
 * auth_type describes how an account SENDS. Reading it is a separate question,
 * answered only by whether IMAP credentials exist.
 */

const base: PollableAccount = {
  email: 'grace@rp.rateupdigital.com',
  status: 'active',
  auth_type: 'ongage',
  imap_host: 'mail.rateupdigital.com',
  imap_user: 'grace@rp.rateupdigital.com',
  imap_pass: 'secret',
};

describe('isPollableForReplies', () => {
  test('an Ongage sender with IMAP credentials IS polled', () => {
    // The whole point: sending through an API says nothing about receiving.
    expect(isPollableForReplies(base)).toBe(true);
  });

  test('an SMTP account with IMAP credentials is still polled', () => {
    expect(isPollableForReplies({ ...base, auth_type: 'smtp' })).toBe(true);
  });

  test('a Gmail OAuth account with IMAP credentials is polled', () => {
    expect(isPollableForReplies({ ...base, auth_type: 'gmail_oauth' })).toBe(true);
  });

  test('no IMAP host means nothing to poll', () => {
    expect(isPollableForReplies({ ...base, imap_host: null })).toBe(false);
  });

  test('missing user or password means nothing to poll', () => {
    expect(isPollableForReplies({ ...base, imap_user: null })).toBe(false);
    expect(isPollableForReplies({ ...base, imap_pass: null })).toBe(false);
  });

  test('blank credentials count as missing, not as empty strings to send', () => {
    expect(isPollableForReplies({ ...base, imap_host: '   ' })).toBe(false);
    expect(isPollableForReplies({ ...base, imap_pass: '' })).toBe(false);
  });

  test('an inactive account is not polled even with full credentials', () => {
    expect(isPollableForReplies({ ...base, status: 'paused' })).toBe(false);
  });
});

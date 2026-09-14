import { describe, test, expect } from 'vitest';
import { readableImapAuth } from './mailbox-access.js';

/**
 * Opening an Ongage reply in the Inbox span the spinner for 30s and then showed
 * the outgoing email alone, even though the reply was sitting in the sender's
 * own mailbox with intact threading headers.
 *
 * Every thread-READING path gated on `auth_type === 'smtp'`, so the three
 * Ongage mailboxes — which carry full IMAP credentials — were skipped, and the
 * lookup fell through to a 20-mailbox sweep that could never match (measured
 * 95.8s, zero hits). The sending side had already learned this lesson: it
 * dispatches on whether the mailbox can send, not on how the campaign was sent.
 * This is the mirror rule for reading.
 */
describe('readableImapAuth', () => {
  const creds = {
    imap_host: 'imap.titan.email',
    imap_port: 993,
    imap_user: 'james@optiratesolutions.net',
    imap_pass: 'secret',
  };

  test('an smtp account is readable', () => {
    expect(readableImapAuth({ auth_type: 'smtp', ...creds })).toEqual(creds);
  });

  test('an ongage account with IMAP credentials is readable', () => {
    // The regression this module exists for. Ongage dispatches the mail, but
    // the replies land in a normal mailbox we hold credentials for.
    expect(readableImapAuth({ auth_type: 'ongage', ...creds })).toEqual(creds);
  });

  test('an app_password account is readable', () => {
    expect(readableImapAuth({ auth_type: 'app_password', ...creds })).toEqual(creds);
  });

  test('an unknown future auth_type with credentials is readable', () => {
    // The rule is about credentials, so a provider added later needs no edit here.
    expect(readableImapAuth({ auth_type: 'postmark', ...creds })).toEqual(creds);
  });

  test('a gmail_oauth account is NOT read over IMAP', () => {
    // Gmail accounts are read through the Gmail API, which threads natively.
    // Routing them here would scan the same mailbox twice per lookup.
    expect(readableImapAuth({ auth_type: 'gmail_oauth', ...creds })).toBeNull();
  });

  test('missing host, user or password means not readable', () => {
    expect(readableImapAuth({ auth_type: 'smtp', ...creds, imap_host: null })).toBeNull();
    expect(readableImapAuth({ auth_type: 'smtp', ...creds, imap_user: null })).toBeNull();
    expect(readableImapAuth({ auth_type: 'smtp', ...creds, imap_pass: null })).toBeNull();
  });

  test('empty-string credentials are missing credentials', () => {
    expect(readableImapAuth({ auth_type: 'smtp', ...creds, imap_pass: '' })).toBeNull();
  });

  test('port defaults to 993 when unset', () => {
    expect(readableImapAuth({ auth_type: 'ongage', ...creds, imap_port: null }))
      .toEqual({ ...creds, imap_port: 993 });
  });

  test('null or undefined account is not readable', () => {
    expect(readableImapAuth(null)).toBeNull();
    expect(readableImapAuth(undefined)).toBeNull();
  });
});

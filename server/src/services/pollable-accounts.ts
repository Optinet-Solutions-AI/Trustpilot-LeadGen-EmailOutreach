/**
 * Which mailboxes the reply poller should read.
 *
 * This used to be `auth_type='smtp'`, which conflated two unrelated things:
 * how an account SENDS, and whether we can READ it. Every mailbox sending
 * through a provider API was therefore invisible to reply polling — including
 * the three Ongage senders that all current outreach goes out from. Replies
 * were landing in those cPanel mailboxes the whole time and nothing looked.
 *
 * The only condition that matters is whether IMAP credentials exist.
 */

export interface PollableAccount {
  email: string;
  status: string | null;
  auth_type: string | null;
  imap_host: string | null;
  imap_user: string | null;
  imap_pass: string | null;
}

const present = (v: string | null | undefined): boolean =>
  typeof v === 'string' && v.trim().length > 0;

/** Active, and has a full set of IMAP credentials. auth_type is irrelevant. */
export function isPollableForReplies(account: PollableAccount): boolean {
  if (account.status !== 'active') return false;
  return present(account.imap_host) && present(account.imap_user) && present(account.imap_pass);
}

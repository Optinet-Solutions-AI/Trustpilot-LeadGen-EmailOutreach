/**
 * Can this mailbox be READ over IMAP, and with what credentials?
 *
 * The sending side already dispatches on what a mailbox can do rather than on
 * how the campaign was sent ("an Ongage row with SMTP credentials sends over
 * SMTP like any other" — see the reply path in routes/inbox.ts). The reading
 * side never followed: every thread lookup tested `auth_type === 'smtp'`, so
 * the Ongage mailboxes were invisible to it even though they hold ordinary
 * IMAP credentials and receive every reply. Opening one of those threads fell
 * through to a sweep of all 20 SMTP mailboxes — 95.8s measured, and it could
 * never match, because the conversation was in a mailbox the sweep excluded.
 *
 * The rule is credentials, not provider: whoever dispatched the outbound mail,
 * a mailbox we hold host + user + password for is a mailbox we can read. A
 * provider added later needs no edit here.
 *
 * gmail_oauth is the one deliberate exception — those are read through the
 * Gmail API, which threads natively and needs no header reconstruction.
 * Including them would scan the same mailbox twice on every lookup.
 */

export interface MailboxAccount {
  auth_type?: string | null;
  imap_host?: string | null;
  imap_port?: number | null;
  imap_user?: string | null;
  imap_pass?: string | null;
}

export interface ImapAuth {
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
}

/** Credentials to read this mailbox over IMAP, or null when it can't be read. */
export function readableImapAuth(account: MailboxAccount | null | undefined): ImapAuth | null {
  if (!account) return null;
  if (account.auth_type === 'gmail_oauth') return null;

  const host = account.imap_host?.trim();
  const user = account.imap_user?.trim();
  const pass = account.imap_pass;
  if (!host || !user || !pass) return null;

  return {
    imap_host: host,
    imap_port: account.imap_port ?? 993,
    imap_user: user,
    imap_pass: pass,
  };
}

/**
 * PostgREST filter naming the mailboxes a scan may open. Mirrors
 * readableImapAuth so the DB query and the in-process check can't drift —
 * the query narrows, this function decides.
 */
export const READABLE_MAILBOX_COLUMNS =
  'email, auth_type, status, imap_host, imap_port, imap_user, imap_pass';

/**
 * Where a reply to an Ongage-sent email should go.
 *
 * It used to default to the sender's own address — grace@rp.rateupdigital.com
 * and friends. Two things made that a dead end:
 *
 *  - Nothing polls those mailboxes. The IMAP reply tracker selects
 *    `auth_type='smtp'` with `imap_host` set, and the Ongage accounts are
 *    `auth_type='ongage'` with no IMAP credentials at all.
 *  - They cannot reliably receive. Each rp.* subdomain carries TWO
 *    equal-preference MX records — InboxRoad, and `mail.<parent-domain>` where
 *    the parent has no MX whatsoever — so inbound mail splits between a
 *    sending relay and a route that does not resolve.
 *
 * Redirecting is safe because reply matching keys on the inbound message's
 * From address against leads we mailed, not on which mailbox received it. Any
 * monitored inbox therefore works.
 */

/** Deliberately loose: enough to reject obvious junk, not to police addresses. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !LOOKS_LIKE_EMAIL.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolution order: the sender's own override, then ONGAGE_REPLY_TO, then the
 * sender address itself.
 *
 * A configured value that is blank or malformed is IGNORED rather than used —
 * a broken Reply-To loses the reply silently, with no bounce anyone sees, so
 * falling back to the sender is the safer failure.
 */
export function resolveReplyTo(
  senderEmail: string,
  perSenderReplyTo: string | null | undefined,
): string {
  return clean(perSenderReplyTo) ?? clean(process.env.ONGAGE_REPLY_TO) ?? senderEmail;
}

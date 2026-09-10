/**
 * Which mailbox answers when the operator replies from the Inbox.
 *
 * Normally the one that sent the original. Ongage senders are the exception
 * and cannot answer for themselves for two independent reasons:
 *
 *  - Ongage's transactional endpoint accepts a subject and a body and nothing
 *    else. No In-Reply-To, no References — the "reply" would land as a new
 *    email outside the thread.
 *  - The Ongage rows carry no SMTP credentials, so there is nothing to fall
 *    back to, and their rp.* addresses cannot receive the next reply anyway.
 *
 * So an Ongage thread is answered by the reply-to mailbox instead. That is
 * the address the prospect actually wrote to, so it is also the one they
 * expect to hear back from.
 */

const SELF_SERVING = new Set(['smtp', 'app_password', 'gmail_oauth']);
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ReplyFrom {
  /** The mailbox that will send. */
  email: string;
  /** True when this is not the account that sent the original. */
  redirected: boolean;
}

/**
 * Returns the sending mailbox, or null when the reply cannot be sent at all —
 * an unknown auth_type, or an Ongage thread with no reply mailbox configured.
 * Null is deliberate: a clear refusal beats sending from an address that can
 * neither thread nor receive the answer.
 */
export function resolveReplyFromAddress(
  authType: string,
  senderEmail: string,
  /**
   * Whether the account carries its own SMTP credentials. An Ongage sender
   * with SMTP can answer as itself — which is what the recipient expects, and
   * keeps the thread on one identity. Only a sender with no way to send at
   * all needs handing off.
   */
  hasOwnSmtp = false,
): ReplyFrom | null {
  if (SELF_SERVING.has(authType) || hasOwnSmtp) {
    return { email: senderEmail, redirected: false };
  }

  if (authType === 'ongage') {
    const configured = (process.env.ONGAGE_REPLY_TO ?? '').trim();
    if (!configured || !LOOKS_LIKE_EMAIL.test(configured)) return null;
    return { email: configured, redirected: true };
  }

  return null;
}

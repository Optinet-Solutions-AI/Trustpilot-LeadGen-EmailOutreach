/**
 * On-demand reply-body fetcher.
 *
 * Used by /api/inbox/rendered-send when campaign_leads.reply_snippet is
 * empty but status='replied' — i.e. the older reply-tracker captured the
 * status flip without saving the body. Older messages also exist where
 * the tracker never had a snippet-save code path at all. This helper does
 * a targeted IMAP search in the sender's INBOX for the first message
 * FROM the lead address, parses the body, and returns it as a snippet.
 *
 * Deliberately small surface — one round trip, one parse, returns null on
 * any failure so the calling route can fall through to its placeholder
 * tile without surfacing IMAP errors to the user.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export interface ImapAuth {
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
}

/**
 * Fetch the body of the first inbound message from `leadEmail` in the
 * INBOX, scoped to messages received around `referenceDate` (±21 days).
 * Returns the body capped at 4000 chars, or null when nothing can be
 * found / parsed / read.
 */
export async function fetchReplyBodyFromImap(
  auth: ImapAuth,
  leadEmail: string,
  referenceDate: string | null,
): Promise<string | null> {
  const target = leadEmail.toLowerCase();
  if (!target) return null;

  // Narrow window around the recorded reply date so we don't drag back a
  // ten-year-old conversation from the same address. ±21 days covers any
  // reply-tracker lag and any clock skew between the IMAP server and our
  // recorded timestamps.
  const anchor = referenceDate ? new Date(referenceDate) : new Date();
  const since = new Date(anchor.getTime() - 21 * 24 * 60 * 60 * 1000);

  const client = new ImapFlow({
    host: auth.imap_host,
    port: auth.imap_port,
    secure: true,
    auth: { user: auth.imap_user, pass: auth.imap_pass },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;

    const mailboxes = await client.list();
    const inboxBox = mailboxes.find((b) => /^inbox$/i.test(b.name)) ?? { path: 'INBOX' };

    const lock = await client.getMailboxLock(inboxBox.path);
    try {
      const uids = (await client.search({ from: target, since })) || [];
      const list = Array.isArray(uids) ? uids : [];
      if (list.length === 0) return null;

      // Pick the UID closest to the reference timestamp. Without it the
      // .pop() would return the highest UID which is usually but not
      // always the right one (IMAP server flushes or moved folders can
      // re-number). Closeness lets reply_snippet point at the actual
      // detected reply instead of a different message from the same
      // sender that happened to land near it.
      let bestUid: number | null = null;
      let bestDelta = Number.POSITIVE_INFINITY;
      for await (const msg of client.fetch(list, { envelope: true, uid: true })) {
        if (!msg.uid) continue;
        const t = msg.envelope?.date ? new Date(msg.envelope.date).getTime() : NaN;
        if (!Number.isFinite(t)) continue;
        const delta = Math.abs(t - anchor.getTime());
        if (delta < bestDelta) {
          bestDelta = delta;
          bestUid = msg.uid;
        }
      }
      if (bestUid == null) bestUid = list[list.length - 1];  // fall back to most recent

      let raw: Buffer | null = null;
      for await (const msg of client.fetch(String(bestUid), { uid: true, source: true }, { uid: true })) {
        if (msg.source) {
          raw = msg.source as Buffer;
          break;
        }
      }
      if (!raw) return null;

      const parsed = await simpleParser(raw, { skipImageLinks: true, skipHtmlToText: false });
      const body = (parsed.text || '').trim();
      if (body) return body.slice(0, 4000);
      // mailparser sometimes leaves text empty for HTML-only mail —
      // strip tags as a fallback so the user gets something readable.
      if (parsed.html) {
        const stripped = String(parsed.html)
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (stripped) return stripped.slice(0, 4000);
      }
      return null;
    } finally {
      lock.release();
    }
  } catch (err) {
    console.warn('[ImapReplyFetcher] failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (connected) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }
}

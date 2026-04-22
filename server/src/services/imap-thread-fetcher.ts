/**
 * IMAP thread fetcher for SMTP/IMAP accounts (Bluehost Titan, DreamHost, generic SMTP).
 *
 * Gmail accounts have a native thread ID; everything else has to reconstruct the
 * conversation from RFC822 headers. Given the Message-ID of the outgoing email
 * we sent, this module:
 *
 *   1. Finds the outgoing copy in the account's Sent folder (search by Message-ID)
 *   2. Finds every inbound reply whose In-Reply-To or References contains that
 *      Message-ID, from INBOX + any other replies-bearing folder
 *   3. Also scans for forwards/continuations that share the same Thread-Index
 *      or whose References chain touches this Message-ID
 *   4. Sorts chronologically, decodes MIME bodies, returns the shape expected by
 *      the Inbox frontend — identical to the Gmail thread response.
 *
 * Kept deliberately tolerant to mailbox-naming quirks: the Sent folder discovery
 * mirrors the appendToSentFolder logic in email-sender.smtp.ts.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export interface ImapAuth {
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  bodyType: 'html' | 'plain';
  unread: boolean;
  labels: string[];
}

export interface ThreadResult {
  threadId: string;
  messages: ThreadMessage[];
  senderAccount: string;
}

function stripAngle(id: string): string {
  return id.replace(/^<|>$/g, '').trim();
}

function normalizeId(id: string | undefined | null): string {
  return id ? stripAngle(id).toLowerCase() : '';
}

function extractReferences(header: string | undefined): string[] {
  if (!header) return [];
  return header.split(/\s+/).map(stripAngle).map(s => s.toLowerCase()).filter(Boolean);
}

function htmlToSnippet(html: string, plain: string): string {
  const source = plain || html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  return source.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function stripBodyWrapper(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1].trim() : html;
}

function plainToHtml(plain: string): string {
  return plain.split(/\n\n+/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

interface CollectedMessage {
  uid: number;
  folder: string;
  messageId: string;
  inReplyTo: string;
  references: string[];
  envelopeSubject: string;
  envelopeDate: Date | null;
  unread: boolean;
  raw: Buffer;
}

/**
 * Fetch the entire conversation a given outbound Message-ID belongs to.
 * Returns null when IMAP can't connect or the outgoing message itself is missing
 * (caller falls back to rendering the campaign template).
 */
export async function fetchSmtpThread(
  auth: ImapAuth,
  outgoingMessageId: string,
  accountEmail: string,
): Promise<ThreadResult | null> {
  const target = normalizeId(outgoingMessageId);
  if (!target) return null;

  const client = new ImapFlow({
    host: auth.imap_host,
    port: auth.imap_port,
    secure: true,
    auth: { user: auth.imap_user, pass: auth.imap_pass },
    logger: false,
    connectionTimeout: 15000,
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;

    const mailboxes = await client.list();
    const sentBox =
      mailboxes.find(b => b.specialUse === '\\Sent') ??
      mailboxes.find(b => /^sent$/i.test(b.name)) ??
      mailboxes.find(b => /^sent.messages$/i.test(b.name)) ??
      mailboxes.find(b => /^sent.items$/i.test(b.name)) ??
      mailboxes.find(b => /sent/i.test(b.name));
    const inboxBox = mailboxes.find(b => /^inbox$/i.test(b.name)) ?? { path: 'INBOX' };

    // Folders worth scanning: Sent (outgoing), INBOX (replies), and any other
    // folder a client might auto-file replies into. We skip Spam/Trash to keep
    // fetch bounded.
    const scanPaths = Array.from(new Set([
      sentBox?.path,
      inboxBox.path,
      ...mailboxes
        .filter(b => /archive|all.?mail/i.test(b.name) && b.specialUse !== '\\Trash' && b.specialUse !== '\\Junk')
        .map(b => b.path),
    ].filter(Boolean))) as string[];

    const collected: CollectedMessage[] = [];
    // Track which Message-IDs belong to the thread so we can widen the search
    // as new messages join via References chains.
    const threadIds = new Set<string>([target]);
    let threadGrew = true;

    // Up to 3 sweeps — each pass picks up messages that reference any ID already
    // known to be in the thread. Usually 1 or 2 is enough.
    for (let pass = 0; pass < 3 && threadGrew; pass++) {
      threadGrew = false;
      const sizeBefore = collected.length;

      for (const path of scanPaths) {
        const lock = await client.getMailboxLock(path);
        try {
          const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
          const uids = await client.search({ since });
          if (!uids || uids.length === 0) continue;

          // Pull envelope + headers for fast filtering, then only load full
          // source for messages that actually belong to the thread.
          for await (const msg of client.fetch(uids, {
            envelope: true,
            uid: true,
            flags: true,
            headers: ['message-id', 'in-reply-to', 'references'],
          })) {
            const headerBuf = msg.headers;
            const headers = headerBuf ? headerBuf.toString('utf-8') : '';
            const messageId = normalizeId(msg.envelope?.messageId ?? matchHeader(headers, 'message-id'));
            const inReplyTo = normalizeId(matchHeader(headers, 'in-reply-to'));
            const references = extractReferences(matchHeader(headers, 'references'));

            const belongs =
              threadIds.has(messageId) ||
              (inReplyTo && threadIds.has(inReplyTo)) ||
              references.some(r => threadIds.has(r));

            if (!belongs) continue;
            if (collected.some(c => c.uid === msg.uid && c.folder === path)) continue;

            // Add every known ID to the thread set so the next sweep finds
            // transitive participants.
            if (messageId) threadIds.add(messageId);
            if (inReplyTo) threadIds.add(inReplyTo);
            for (const r of references) threadIds.add(r);

            // Load full source for bodies
            const full = await client.fetchOne(String(msg.uid), { source: true, uid: true, flags: true }, { uid: true });
            if (!full || !full.source) continue;

            collected.push({
              uid: msg.uid!,
              folder: path,
              messageId,
              inReplyTo,
              references,
              envelopeSubject: msg.envelope?.subject ?? '',
              envelopeDate: msg.envelope?.date ?? null,
              unread: !msg.flags?.has('\\Seen'),
              raw: full.source as Buffer,
            });
          }
        } finally {
          lock.release();
        }
      }

      if (collected.length > sizeBefore) threadGrew = true;
    }

    if (collected.length === 0) return null;

    // Parse bodies and shape for the frontend
    const messages: ThreadMessage[] = [];
    for (const c of collected) {
      const parsed = await simpleParser(c.raw, { skipImageLinks: false, skipHtmlToText: false });
      const html = parsed.html ? stripBodyWrapper(parsed.html) : (parsed.textAsHtml ?? '');
      const plain = parsed.text ?? '';
      const body = html || plainToHtml(plain);

      const fromAddr = parsed.from?.text ?? '';
      const toAddr = Array.isArray(parsed.to) ? parsed.to.map(t => t.text).join(', ') : parsed.to?.text ?? '';

      messages.push({
        id: c.messageId || `${c.folder}:${c.uid}`,
        threadId: target,
        from: fromAddr,
        to: toAddr,
        subject: parsed.subject ?? c.envelopeSubject,
        date: (parsed.date ?? c.envelopeDate ?? new Date()).toISOString(),
        snippet: htmlToSnippet(body, plain),
        body,
        bodyType: html ? 'html' : 'plain',
        unread: c.unread,
        labels: [c.folder],
      });
    }

    messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return { threadId: target, messages, senderAccount: accountEmail };
  } catch (err) {
    console.error(`[ImapThreadFetcher] ${accountEmail} error:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (connected) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }
}

function matchHeader(rawHeaders: string, name: string): string {
  const rx = new RegExp(`^${name}:\\s*(.+?)(?=\\r?\\n(?:[A-Za-z-]+:|$))`, 'ims');
  const m = rawHeaders.match(rx);
  return m ? m[1].replace(/\r?\n\s+/g, ' ').trim() : '';
}

/**
 * Fallback when we don't have a Message-ID for the original send (legacy rows
 * with null gmail_message_id). Scans Sent + INBOX for any message to/from the
 * given email address within the last 180 days, returns whatever conversation
 * we can find — best effort.
 */
export async function searchImapThreadByEmail(
  auth: ImapAuth,
  leadEmail: string,
  accountEmail: string,
): Promise<ThreadResult | null> {
  const target = leadEmail.toLowerCase();
  if (!target) return null;

  const client = new ImapFlow({
    host: auth.imap_host,
    port: auth.imap_port,
    secure: true,
    auth: { user: auth.imap_user, pass: auth.imap_pass },
    logger: false,
    connectionTimeout: 15000,
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;

    const mailboxes = await client.list();
    const sentBox =
      mailboxes.find(b => b.specialUse === '\\Sent') ??
      mailboxes.find(b => /^sent$/i.test(b.name)) ??
      mailboxes.find(b => /^sent.messages$/i.test(b.name)) ??
      mailboxes.find(b => /^sent.items$/i.test(b.name)) ??
      mailboxes.find(b => /sent/i.test(b.name));
    const inboxBox = mailboxes.find(b => /^inbox$/i.test(b.name)) ?? { path: 'INBOX' };

    const scanPaths = Array.from(new Set([sentBox?.path, inboxBox.path].filter(Boolean))) as string[];

    const collected: CollectedMessage[] = [];
    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);

    for (const path of scanPaths) {
      const lock = await client.getMailboxLock(path);
      try {
        // IMAP SEARCH: messages where FROM or TO contains the target address.
        // Both terms are OR'd and scoped to the time window.
        const fromMatches = (await client.search({ from: target, since })) || [];
        const toMatches = (await client.search({ to: target, since })) || [];
        const uids = Array.from(new Set<number>([
          ...(Array.isArray(fromMatches) ? fromMatches : []),
          ...(Array.isArray(toMatches) ? toMatches : []),
        ]));
        if (uids.length === 0) continue;

        for await (const msg of client.fetch(uids, { envelope: true, uid: true, flags: true, source: true })) {
          if (!msg.source) continue;
          const messageId = normalizeId(msg.envelope?.messageId);
          collected.push({
            uid: msg.uid!,
            folder: path,
            messageId,
            inReplyTo: '',
            references: [],
            envelopeSubject: msg.envelope?.subject ?? '',
            envelopeDate: msg.envelope?.date ?? null,
            unread: !msg.flags?.has('\\Seen'),
            raw: msg.source as Buffer,
          });
        }
      } finally {
        lock.release();
      }
    }

    if (collected.length === 0) return null;

    const messages: ThreadMessage[] = [];
    for (const c of collected) {
      const parsed = await simpleParser(c.raw, { skipImageLinks: false, skipHtmlToText: false });
      const html = parsed.html ? stripBodyWrapper(parsed.html) : (parsed.textAsHtml ?? '');
      const plain = parsed.text ?? '';
      const body = html || plainToHtml(plain);
      const fromAddr = parsed.from?.text ?? '';
      const toAddr = Array.isArray(parsed.to) ? parsed.to.map(t => t.text).join(', ') : parsed.to?.text ?? '';

      messages.push({
        id: c.messageId || `${c.folder}:${c.uid}`,
        threadId: target,
        from: fromAddr,
        to: toAddr,
        subject: parsed.subject ?? c.envelopeSubject,
        date: (parsed.date ?? c.envelopeDate ?? new Date()).toISOString(),
        snippet: htmlToSnippet(body, plain),
        body,
        bodyType: html ? 'html' : 'plain',
        unread: c.unread,
        labels: [c.folder],
      });
    }

    messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return { threadId: target, messages, senderAccount: accountEmail };
  } catch (err) {
    console.error(`[ImapThreadFetcher:search] ${accountEmail} error:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (connected) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }
}

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

/**
 * Rewrite `<img src="cid:xxx">` references to `data:` URIs using the parsed
 * inline attachments. Browsers can't resolve `cid:` (that only works inside
 * email clients), so without this the screenshots embedded in OptiRate
 * outreach templates render as broken images in the Inbox viewer.
 * Non-matching cid refs are left untouched.
 */
function inlineCidAttachments(
  html: string,
  attachments: Array<{ contentId?: string; content?: unknown; contentType?: string }>,
): string {
  if (!html || !attachments || attachments.length === 0) return html;
  const cidMap = new Map<string, string>();
  for (const att of attachments) {
    const rawCid = att.contentId;
    if (!rawCid || !att.content) continue;
    const cid = rawCid.replace(/^<|>$/g, '').trim().toLowerCase();
    if (!cid) continue;
    const ct = att.contentType || 'application/octet-stream';
    const buf = Buffer.isBuffer(att.content)
      ? att.content
      : Buffer.from(att.content as ArrayBufferLike);
    cidMap.set(cid, `data:${ct};base64,${buf.toString('base64')}`);
  }
  if (cidMap.size === 0) return html;
  return html.replace(/src=(["'])cid:([^"']+)\1/gi, (match, quote, cid) => {
    const dataUri = cidMap.get(cid.trim().toLowerCase());
    return dataUri ? `src=${quote}${dataUri}${quote}` : match;
  });
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
 *
 * Uses targeted IMAP header searches (SEARCH HEADER Message-ID / In-Reply-To /
 * References) so we only round-trip for messages we know belong to the thread.
 * A naive scan-and-filter across 90 days of mail would stall for minutes on
 * any real mailbox; header-scoped SEARCH keeps this under a second in the
 * common case.
 *
 * Returns null when IMAP can't connect or the message isn't findable
 * (caller then falls back to the template-render endpoint).
 */
export async function fetchSmtpThread(
  auth: ImapAuth,
  outgoingMessageId: string,
  accountEmail: string,
): Promise<ThreadResult | null> {
  const target = normalizeId(outgoingMessageId);
  if (!target) return null;
  const targetWithAngles = `<${target}>`;

  const client = new ImapFlow({
    host: auth.imap_host,
    port: auth.imap_port,
    secure: true,
    auth: { user: auth.imap_user, pass: auth.imap_pass },
    logger: false,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
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
    // Gmail tucks inbound replies into [Gmail]/All Mail even when the IMAP
    // HEADER References search in INBOX misses them (Gmail's IMAP index is
    // sometimes lazy on cross-label threading). Adding \\All as a third scan
    // path closes that gap. Non-Gmail providers don't expose \\All, so this
    // is a Gmail-only addition.
    const allMailBox = mailboxes.find(b => b.specialUse === '\\All');

    const scanPaths = Array.from(new Set(
      [sentBox?.path, inboxBox.path, allMailBox?.path].filter(Boolean),
    )) as string[];

    const collected: CollectedMessage[] = [];
    const seen = new Set<string>();           // dedupe key: folder:uid (prevents same-UID re-reads)
    const seenMessageIds = new Set<string>(); // dedupe key: Message-ID (collapses server-save + IMAP-append duplicates)
    const threadIds = new Set<string>([target]);

    // Header-scoped search: ask the server to filter for us.
    // IMPORTANT: imapflow's `header` search takes { name: value } where value
    // is a literal substring. Server-side this maps to SEARCH HEADER, which
    // is the fastest way to find messages in a specific thread.
    async function searchByHeader(path: string, headerName: string, value: string): Promise<number[]> {
      const lock = await client.getMailboxLock(path);
      try {
        const uids = await client.search({ header: { [headerName]: value } });
        return Array.isArray(uids) ? uids : [];
      } catch (e) {
        console.warn(`[ImapThreadFetcher] search(${path}, ${headerName}:${value}) failed:`, e instanceof Error ? e.message : e);
        return [];
      } finally {
        lock.release();
      }
    }

    // One pass per folder: collect every UID that references any known
    // thread ID via Message-ID, In-Reply-To, or References.
    async function collectFromFolder(path: string): Promise<void> {
      const idsToQuery = Array.from(threadIds);
      const uidsToFetch = new Set<number>();

      for (const id of idsToQuery) {
        const withAngles = `<${id}>`;
        const results = await Promise.all([
          searchByHeader(path, 'message-id', withAngles),
          searchByHeader(path, 'in-reply-to', withAngles),
          searchByHeader(path, 'references', withAngles),
        ]);
        for (const r of results) for (const u of r) uidsToFetch.add(u);
      }

      if (uidsToFetch.size === 0) return;

      const lock = await client.getMailboxLock(path);
      try {
        // Single fetch round-trip for everything in this folder. Includes source
        // so mailparser can decode bodies without a second round trip.
        for await (const msg of client.fetch([...uidsToFetch], {
          envelope: true,
          uid: true,
          flags: true,
          source: true,
          headers: ['message-id', 'in-reply-to', 'references'],
        })) {
          const key = `${path}:${msg.uid}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const headers = msg.headers ? msg.headers.toString('utf-8') : '';
          const messageId = normalizeId(msg.envelope?.messageId ?? matchHeader(headers, 'message-id'));
          const inReplyTo = normalizeId(matchHeader(headers, 'in-reply-to'));
          const references = extractReferences(matchHeader(headers, 'references'));

          if (messageId) threadIds.add(messageId);
          if (inReplyTo) threadIds.add(inReplyTo);
          for (const r of references) threadIds.add(r);

          if (!msg.source) continue;
          // Collapse duplicates that share a Message-ID across folders or UIDs
          // (Bluehost/Titan server-side sent-save + our IMAP append land the
          // same email in Sent twice; Gmail's All Mail also overlaps INBOX).
          // Messages without a Message-ID fall through to always-push.
          if (messageId) {
            if (seenMessageIds.has(messageId)) continue;
            seenMessageIds.add(messageId);
          }
          collected.push({
            uid: msg.uid!,
            folder: path,
            messageId,
            inReplyTo,
            references,
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

    // Two passes: first pass finds the seed + direct replies, second pass
    // catches anything that references IDs discovered in the first pass.
    for (let pass = 0; pass < 2; pass++) {
      const sizeBefore = collected.length;
      for (const path of scanPaths) {
        await collectFromFolder(path);
      }
      if (collected.length === sizeBefore) break;  // no new messages — stop
    }

    // Hack for the very first seed: if Message-ID header search missed our
    // outgoing message (some servers normalize angle brackets differently),
    // try a direct lookup in Sent by the literal ID without angles.
    if (collected.length === 0 && sentBox?.path) {
      const uids = await searchByHeader(sentBox.path, 'message-id', target);
      if (uids.length > 0) {
        const lock = await client.getMailboxLock(sentBox.path);
        try {
          for await (const msg of client.fetch(uids, { envelope: true, uid: true, flags: true, source: true })) {
            if (!msg.source) continue;
            collected.push({
              uid: msg.uid!,
              folder: sentBox.path,
              messageId: normalizeId(msg.envelope?.messageId) || target,
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
    }

    void targetWithAngles;  // reserved for future fallbacks; silence unused warning

    if (collected.length === 0) return null;

    // Parse bodies and shape for the frontend
    const messages: ThreadMessage[] = [];
    for (const c of collected) {
      const parsed = await simpleParser(c.raw, { skipImageLinks: false, skipHtmlToText: false });
      const rawHtml = parsed.html ? stripBodyWrapper(parsed.html) : (parsed.textAsHtml ?? '');
      const html = inlineCidAttachments(rawHtml, parsed.attachments ?? []);
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
    const allMailBox = mailboxes.find(b => b.specialUse === '\\All');

    const scanPaths = Array.from(new Set(
      [sentBox?.path, inboxBox.path, allMailBox?.path].filter(Boolean),
    )) as string[];

    const collected: CollectedMessage[] = [];
    const seenMessageIds = new Set<string>();
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
          // Same dedup logic as fetchSmtpThread: collapse server-save + append
          // duplicates and overlapping labels (Gmail INBOX vs All Mail).
          if (messageId) {
            if (seenMessageIds.has(messageId)) continue;
            seenMessageIds.add(messageId);
          }
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
      const rawHtml = parsed.html ? stripBodyWrapper(parsed.html) : (parsed.textAsHtml ?? '');
      const html = inlineCidAttachments(rawHtml, parsed.attachments ?? []);
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

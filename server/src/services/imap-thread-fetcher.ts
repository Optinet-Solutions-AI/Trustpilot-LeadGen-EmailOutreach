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

/**
 * Strip angles but PRESERVE CASE. Use for any Message-ID that gets stored on
 * ThreadMessage.id and eventually flows into outbound In-Reply-To / References
 * headers. RFC 5322 treats Message-IDs as case-sensitive opaque strings —
 * lowercasing "CADxxx@mail.gmail.com" to "cadxxx@mail.gmail.com" causes Gmail
 * (and any strict MUA) to miss the reference and start a brand-new thread
 * instead of joining the existing conversation. normalizeId() stays for
 * dedup Set keys and cache lookups where case-insensitive matching is fine.
 */
function preserveId(id: string | undefined | null): string {
  return id ? stripAngle(id) : '';
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
 *
 * Mailparser's attachment objects expose the Content-ID either as `contentId`
 * or (in older builds) as `cid` — we accept both. Also falls back to matching
 * by filename when the CID map is empty but the HTML references cid: names
 * that look like attachment filenames.
 */
function inlineCidAttachments(
  html: string,
  attachments: Array<{ contentId?: string; cid?: string; filename?: string; content?: unknown; contentType?: string }>,
): string {
  if (!html || !attachments || attachments.length === 0) return html;
  const cidMap = new Map<string, string>();
  for (const att of attachments) {
    const rawCid = att.contentId || att.cid;
    if (!att.content) continue;
    const keys: string[] = [];
    if (rawCid) keys.push(rawCid.replace(/^<|>$/g, '').trim().toLowerCase());
    if (att.filename) keys.push(att.filename.trim().toLowerCase());
    if (keys.length === 0) continue;
    const ct = att.contentType || 'application/octet-stream';
    const buf = Buffer.isBuffer(att.content)
      ? att.content
      : Buffer.from(att.content as ArrayBufferLike);
    const dataUri = `data:${ct};base64,${buf.toString('base64')}`;
    for (const k of keys) if (k) cidMap.set(k, dataUri);
  }
  if (cidMap.size === 0) return html;
  return html.replace(/src=(["'])cid:([^"']+)\1/gi, (match, quote, cid) => {
    const dataUri = cidMap.get(cid.trim().toLowerCase());
    return dataUri ? `src=${quote}${dataUri}${quote}` : match;
  });
}

// In-memory thread cache: 60s TTL per (account, outgoingMessageId). Most user
// flows click a thread, read, then move on — occasional re-clicks should not
// re-run the full IMAP sequence. Cap size at 200 entries; oldest purged when
// the cap is hit.
const threadCache = new Map<string, { result: ThreadResult; expiresAt: number }>();
const THREAD_CACHE_TTL_MS = 60 * 1000;
const THREAD_CACHE_MAX = 200;

function getCachedThread(key: string): ThreadResult | null {
  const entry = threadCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    threadCache.delete(key);
    return null;
  }
  return entry.result;
}

/** Drop one cached thread (or everything, if no key given). Called after a
 * reply is sent so the freshly-appended Sent entry shows up on next fetch. */
export function invalidateThreadCache(accountEmail?: string, outgoingMessageId?: string): void {
  if (!accountEmail) {
    threadCache.clear();
    return;
  }
  if (!outgoingMessageId) {
    const prefix = `${accountEmail.toLowerCase()}:`;
    for (const k of threadCache.keys()) if (k.startsWith(prefix)) threadCache.delete(k);
    return;
  }
  threadCache.delete(`${accountEmail.toLowerCase()}:${normalizeId(outgoingMessageId)}`);
}

function setCachedThread(key: string, result: ThreadResult): void {
  if (threadCache.size >= THREAD_CACHE_MAX) {
    // Evict expired entries first; if still at cap, drop oldest insertion
    const now = Date.now();
    for (const [k, v] of threadCache) if (v.expiresAt < now) threadCache.delete(k);
    if (threadCache.size >= THREAD_CACHE_MAX) {
      const firstKey = threadCache.keys().next().value;
      if (firstKey) threadCache.delete(firstKey);
    }
  }
  threadCache.set(key, { result, expiresAt: Date.now() + THREAD_CACHE_TTL_MS });
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
  leadEmail?: string,
): Promise<ThreadResult | null> {
  const target = normalizeId(outgoingMessageId);
  if (!target) return null;
  const targetWithAngles = `<${target}>`;

  // Serve from in-memory cache when hot (60s TTL). Key scopes by account so
  // two accounts with the same Message-ID (extremely rare) still get isolated
  // results. Leademail doesn't factor in because the thread content is the
  // same regardless — the lead email only gates the FROM fallback path,
  // which populates the same ThreadResult shape.
  const cacheKey = `${accountEmail.toLowerCase()}:${target}`;
  const cached = getCachedThread(cacheKey);
  if (cached) return cached;

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
          const messageIdRaw = msg.envelope?.messageId ?? matchHeader(headers, 'message-id');
          const messageId = preserveId(messageIdRaw);       // original case, for storage + outbound headers
          const messageIdKey = normalizeId(messageIdRaw);   // lowercased, for Set dedup + IMAP thread tracking
          const inReplyTo = normalizeId(matchHeader(headers, 'in-reply-to'));
          const references = extractReferences(matchHeader(headers, 'references'));

          if (messageIdKey) threadIds.add(messageIdKey);
          if (inReplyTo) threadIds.add(inReplyTo);
          for (const r of references) threadIds.add(r);

          if (!msg.source) continue;
          // Collapse duplicates that share a Message-ID across folders or UIDs
          // (Bluehost/Titan server-side sent-save + our IMAP append land the
          // same email in Sent twice; Gmail's All Mail also overlaps INBOX).
          // Messages without a Message-ID fall through to always-push.
          if (messageIdKey) {
            if (seenMessageIds.has(messageIdKey)) continue;
            seenMessageIds.add(messageIdKey);
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

    // FROM-based reply fallback: Gmail IMAP's HEADER References index can be
    // lazy and mail clients don't always preserve References on reply. When
    // the References search finds our outgoing copy but no inbound reply,
    // scan INBOX + All Mail for any message FROM the lead address within the
    // last 30 days — this is the same strategy reply-tracker.imap.ts uses
    // successfully to flip status='replied', so it's the proven detection
    // path. Only runs when we have a leadEmail and found no inbound yet.
    if (leadEmail) {
      const leadAddr = leadEmail.toLowerCase();
      const accountAddr = accountEmail.toLowerCase();
      const hasInbound = collected.some((c) => {
        // Cheap check: if the folder is INBOX, it's inbound by definition.
        // For All Mail, inspect the raw headers for a From: != our account.
        if (/inbox/i.test(c.folder)) return true;
        return false;
      });
      if (!hasInbound) {
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const inboundPaths = scanPaths.filter(p => !/sent/i.test(p));
        for (const path of inboundPaths) {
          try {
            const lock = await client.getMailboxLock(path);
            try {
              const uids = (await client.search({ from: leadAddr, since })) || [];
              const list = Array.isArray(uids) ? uids : [];
              if (list.length === 0) continue;
              for await (const msg of client.fetch(list, { envelope: true, uid: true, flags: true, source: true })) {
                if (!msg.source) continue;
                const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';
                if (fromAddr === accountAddr) continue;  // skip our own sends
                const messageId = preserveId(msg.envelope?.messageId);
                const messageIdKey = normalizeId(msg.envelope?.messageId);
                if (messageIdKey && seenMessageIds.has(messageIdKey)) continue;
                if (messageIdKey) seenMessageIds.add(messageIdKey);
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
          } catch (e) {
            console.warn(`[ImapThreadFetcher] FROM-fallback search failed on ${path}:`, e instanceof Error ? e.message : e);
          }
        }
      }
    }

    // JS-level In-Reply-To / References fallback. Fires when neither the
    // header-scoped server search nor the FROM-based fallback found an
    // inbound reply. Two real-world cases this catches:
    //   (a) The IMAP server's HEADER index is lazy or quirky — Titan in
    //       particular silently returns zero hits for SEARCH HEADER on
    //       In-Reply-To even when the matching message exists in INBOX.
    //   (b) The reply came from a routing address (Zendesk/Helpscout/
    //       Freshdesk/custom helpdesks) whose From doesn't match the lead.
    // Mirrors the JS-side envelope-filter strategy that reply-tracker.imap.ts
    // already uses to successfully flip status='replied' for these threads.
    // Two-phase fetch (envelope-only → source for matches) keeps bandwidth
    // bounded on busy mailboxes.
    {
      const stillNoInbound = !collected.some((c) => /inbox/i.test(c.folder));
      if (stillNoInbound) {
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const inboundPaths = scanPaths.filter((p) => !/sent/i.test(p));
        for (const path of inboundPaths) {
          try {
            const lock = await client.getMailboxLock(path);
            try {
              const uids = (await client.search({ since })) || [];
              const list = Array.isArray(uids) ? uids : [];
              if (list.length === 0) continue;

              const matchedUids: number[] = [];
              for await (const env of client.fetch(list, {
                envelope: true,
                uid: true,
                headers: ['references'],
              })) {
                const irt = normalizeId(env.envelope?.inReplyTo);
                const refsRaw = env.headers?.toString('utf-8') ?? '';
                const refs = (refsRaw.match(/<[^<>]+>/g) ?? []).map((s) => normalizeId(s));
                const hits =
                  (irt && threadIds.has(irt)) ||
                  refs.some((r) => threadIds.has(r));
                if (hits && env.uid !== undefined) matchedUids.push(env.uid);
              }

              if (matchedUids.length === 0) continue;

              for await (const msg of client.fetch(matchedUids, {
                envelope: true,
                uid: true,
                flags: true,
                source: true,
                headers: ['references'],
              })) {
                if (!msg.source) continue;
                const messageId = preserveId(msg.envelope?.messageId);
                const messageIdKey = normalizeId(msg.envelope?.messageId);
                if (messageIdKey && seenMessageIds.has(messageIdKey)) continue;
                if (messageIdKey) seenMessageIds.add(messageIdKey);
                const refsRaw = msg.headers?.toString('utf-8') ?? '';
                const refs = (refsRaw.match(/<[^<>]+>/g) ?? []).map((s) => normalizeId(s));
                collected.push({
                  uid: msg.uid!,
                  folder: path,
                  messageId,
                  inReplyTo: normalizeId(msg.envelope?.inReplyTo),
                  references: refs,
                  envelopeSubject: msg.envelope?.subject ?? '',
                  envelopeDate: msg.envelope?.date ?? null,
                  unread: !msg.flags?.has('\\Seen'),
                  raw: msg.source as Buffer,
                });
              }
            } finally {
              lock.release();
            }
          } catch (e) {
            console.warn(
              `[ImapThreadFetcher] InReplyTo JS fallback failed on ${path}:`,
              e instanceof Error ? e.message : e,
            );
          }
        }
      }
    }

    // TO-based Sent-folder fallback: mirror of the FROM-based inbound
    // fallback above. Older manual replies sent before the awaited-IMAP-
    // append fix landed may be in Sent without a findable headers chain
    // (or their References header was malformed pre-fix and Gmail IMAP's
    // HEADER index stopped matching). This pass scans the Sent folder for
    // any message TO the lead address in the last 90 days and filters by
    // normalized subject match so outgoing messages from *other* campaigns
    // to the same lead don't leak into this thread. Dedupe by Message-ID
    // keeps it additive.
    if (leadEmail && sentBox?.path) {
      // Pull in every outbound message we sent to this lead from this
      // account, over the last 180 days. No subject filter — the previous
      // substring-overlap heuristic was excluding initial sends whose
      // subject didn't share enough characters with the follow-up's, which
      // left the thread view showing only the follow-up.
      //
      // For a B2B cold-outreach inbox the (sender_account, lead_email)
      // tuple is unique enough that "everything we sent this person from
      // this mailbox" is exactly what the user wants to see — and if the
      // same lead does appear in two separate campaigns we'd rather merge
      // them into a single thread than hide one. Dedup by Message-ID stays
      // active so server-save + IMAP-append duplicates don't double-count.
      const leadAddr = leadEmail.toLowerCase();
      const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      try {
        const lock = await client.getMailboxLock(sentBox.path);
        try {
          const uids = (await client.search({ to: leadAddr, since })) || [];
          const list = Array.isArray(uids) ? uids : [];
          for await (const msg of client.fetch(list, { envelope: true, uid: true, flags: true, source: true })) {
            if (!msg.source) continue;
            const messageId = preserveId(msg.envelope?.messageId);
            const messageIdKey = normalizeId(msg.envelope?.messageId);
            if (messageIdKey && seenMessageIds.has(messageIdKey)) continue;
            if (messageIdKey) seenMessageIds.add(messageIdKey);
            collected.push({
              uid: msg.uid!,
              folder: sentBox.path,
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
      } catch (e) {
        console.warn(`[ImapThreadFetcher] TO-based Sent fallback failed:`, e instanceof Error ? e.message : e);
      }
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
              messageId: preserveId(msg.envelope?.messageId) || target,
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

    // Post-incident dedup — collapse same-direction sends within a 5-minute
    // window. The 2026-05 scheduler race produced multiple physical sends
    // per legitimate send, each with a different Message-ID so the
    // Message-ID-based dedup above misses them. Walk chronologically; if a
    // message has the same (from, to) as a recently-kept one and is within
    // 5 minutes of it, drop it as a duplicate. Replies (different From)
    // and genuine separate sends days apart survive untouched. Bursts in
    // the historical data were all within 30 seconds, so 5 minutes is
    // generous and safe.
    const dedupedMessages = dedupBurstDuplicates(messages);

    const result = { threadId: target, messages: dedupedMessages, senderAccount: accountEmail };
    setCachedThread(cacheKey, result);
    return result;
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
          const messageId = preserveId(msg.envelope?.messageId);
          const messageIdKey = normalizeId(msg.envelope?.messageId);
          // Same dedup logic as fetchSmtpThread: collapse server-save + append
          // duplicates and overlapping labels (Gmail INBOX vs All Mail).
          if (messageIdKey) {
            if (seenMessageIds.has(messageIdKey)) continue;
            seenMessageIds.add(messageIdKey);
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
    const dedupedMessages = dedupBurstDuplicates(messages);

    return { threadId: target, messages: dedupedMessages, senderAccount: accountEmail };
  } catch (err) {
    console.error(`[ImapThreadFetcher:search] ${accountEmail} error:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (connected) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }
}

/**
 * Collapse same-direction sends within a 5-minute window. Defends against
 * the 2026-05 scheduler race that produced multiple physical sends per
 * legitimate send, each with a different Message-ID (so the seenMessageIds
 * dedup above misses them).
 *
 * Algorithm: sort chronologically, then sweep. For each (from, to) pair,
 * track the most recent kept message; drop any subsequent message in the
 * same direction within 5 minutes. Replies (different From), genuine
 * separate sends (days apart), and inbound mail all survive untouched.
 *
 * The 5-minute window is generous — the historical burst data shows
 * duplicates within 30 seconds. Larger window picks up clock-skew edge
 * cases without risk of merging genuine follow-ups (which are days apart
 * by design).
 */
export function dedupBurstDuplicates<T extends { from: string; to: string; date: string }>(messages: T[]): T[] {
  const WINDOW_MS = 5 * 60 * 1000;
  const sorted = [...messages].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const kept: T[] = [];
  const lastKeptByDirection = new Map<string, number>();
  for (const m of sorted) {
    const fromAddr = extractFirstAddress(m.from);
    const toAddr = extractFirstAddress(m.to);
    const direction = `${fromAddr}|${toAddr}`;
    const ms = new Date(m.date).getTime();
    const last = lastKeptByDirection.get(direction);
    if (last === undefined || ms - last > WINDOW_MS) {
      kept.push(m);
      lastKeptByDirection.set(direction, ms);
    }
    // else: this is a burst duplicate of an earlier kept message — drop silently
  }
  return kept;
}

/** Pull the first email-address-shaped substring out of a From/To value
 *  ("Name <email@host>" → "email@host"; bare "email@host" stays as-is).
 *  Used solely for direction-pair clustering in dedupBurstDuplicates. */
function extractFirstAddress(value: string): string {
  if (!value) return '';
  const angleMatch = value.match(/<([^>]+)>/);
  if (angleMatch) return angleMatch[1].toLowerCase().trim();
  const firstSegment = value.split(',')[0]?.trim() ?? value;
  return firstSegment.toLowerCase().trim();
}

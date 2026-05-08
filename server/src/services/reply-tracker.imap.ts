/**
 * IMAP reply tracker for SMTP/IMAP accounts (Bluehost Titan, DreamHost, etc.).
 *
 * Polls the account's INBOX for messages whose "From" matches a lead we sent
 * a campaign email FROM this same account. Gmail accounts use reply-tracker.ts
 * instead — this one covers every auth_type='smtp' account in email_accounts.
 *
 * Matching strategy (first hit wins):
 *   1. From: address equals the address we originally emailed
 *   2. In-Reply-To: header equals the Message-ID of our outgoing email
 *   3. References: chain contains the Message-ID of our outgoing email
 *
 * Strategies 2 + 3 catch replies routed through helpdesk/ticketing systems
 * (Zendesk, Helpscout, Freshdesk, etc.) where the visible "From" is a
 * ticket-specific address but the threading headers correctly point at the
 * original email.
 *
 * Scans messages from the last 7 days to keep fetch volume bounded.
 *
 * Auto-reply handling: once a message matches, we fetch its full RFC822
 * source via mailparser, run the auto-reply detector, and route to either
 * the human-reply path (status='replied') or the auto-reply path
 * (status='auto_replied' + extract candidates → discovered_contacts).
 * Gated on config.autoReplyHandlingEnabled.
 */

import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getSupabase } from '../lib/supabase.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { config } from '../config.js';
import { classifyReply } from './auto-reply-detector.js';
import { extractContacts } from './auto-reply-extractor.js';
import { insertDiscoveredContact } from '../db/discovered-contacts.js';

export interface ImapAccount {
  id: string;
  email: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
}

type LeadRef = { id: string; lead_id: string; campaign_id: string; email_used: string | null };
type MatchStrategy = 'from' | 'in-reply-to' | 'references';

function normalizeMessageId(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/^</, '').replace(/>$/, '').toLowerCase();
}

export async function checkRepliesImap(
  account: ImapAccount,
): Promise<{ repliesFound: number; autoRepliesFound: number; scanned: number }> {
  const supabase = getSupabase();
  let repliesFound = 0;
  let autoRepliesFound = 0;
  let scanned = 0;

  // Load every campaign_lead this account has sent to (and isn't already replied/bounced)
  const { data: sentLeads } = await supabase
    .from('campaign_leads')
    .select('id, lead_id, campaign_id, email_used, gmail_message_id')
    .eq('status', 'sent')
    .eq('sender_email', account.email);

  if (!sentLeads?.length) {
    console.log(`[ImapReplyTracker] ${account.email}: no sent-and-unreplied leads to watch`);
    return { repliesFound: 0, autoRepliesFound: 0, scanned: 0 };
  }

  // Two parallel lookup maps — From-address match and Message-ID threading.
  // Both keys point to the same lead refs so a matched lead can be removed
  // from both maps to prevent double-processing.
  const leadByEmail = new Map<string, LeadRef>();
  const leadByMessageId = new Map<string, LeadRef>();
  for (const l of sentLeads) {
    const ref: LeadRef = { id: l.id, lead_id: l.lead_id, campaign_id: l.campaign_id, email_used: l.email_used };
    if (l.email_used) leadByEmail.set(l.email_used.toLowerCase(), ref);
    const mid = normalizeMessageId(l.gmail_message_id);
    if (mid) leadByMessageId.set(mid, ref);
  }

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: { user: account.imap_user, pass: account.imap_pass },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    // Idle-socket lifetime. Set above the realistic worst case for a 7-day
    // INBOX scan with secondary per-match body fetches (Titan is ~50s for 80
    // messages with 6 matches), so the poll completes in one go instead of
    // matching only 1 reply before the socket dies and waiting another 10
    // minutes for the next tick.
    socketTimeout: 180000,
  });

  // Swallow socket-level errors (e.g. mid-fetch TLS resets, post-logout
  // teardown timeouts). These were surfacing as unprefixed "Error: Socket
  // timeout" lines in Cloud Run logs every poll cycle.
  client.on('error', (err: Error) => {
    console.warn(`[ImapReplyTracker] ${account.email} socket: ${err.message}`);
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;

    const lock = await client.getMailboxLock('INBOX');
    try {
      // Only scan messages from the last 7 days — bounded fetch volume
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since });
      if (!uids || uids.length === 0) {
        return { repliesFound: 0, autoRepliesFound: 0, scanned: 0 };
      }

      // Helper: drop a matched lead from BOTH lookup maps so the same campaign_lead
      // can't be flipped twice within one poll (e.g. a thread that hits both
      // From-address and Message-ID strategies).
      const dropLead = (ref: LeadRef) => {
        for (const [k, v] of leadByEmail) if (v.id === ref.id) leadByEmail.delete(k);
        for (const [k, v] of leadByMessageId) if (v.id === ref.id) leadByMessageId.delete(k);
      };

      const handleMatch = async (
        lead: LeadRef,
        msg: FetchMessageObject,
        opts: { fromAddr: string; subject: string; matchedBy: MatchStrategy },
      ): Promise<{ matched: boolean; isAuto: boolean }> => {
        // Fetch the body for the matched UID. We deliberately don't carry
        // source through the initial fetch — that would download the body of
        // every message in the 7-day window even though most aren't matches.
        // A second per-match fetch costs one extra round-trip but keeps the
        // common case (1–2 matches per poll) cheap.
        const sourceBuf = await fetchSourceForUid(client, msg.uid!);
        const parsedBody = sourceBuf ? await parseBody(sourceBuf) : { headers: {}, body: '' };

        const verdict = classifyReply({
          headers: parsedBody.headers,
          subject: opts.subject,
          body: parsedBody.body,
        });
        const isAuto = verdict.kind === 'auto' || verdict.kind === 'ticket';

        if (isAuto && config.autoReplyHandlingEnabled) {
          const ok = await markAutoReplied({
            lead,
            account,
            classifier: verdict,
            opts,
            body: parsedBody.body,
            messageId: opts.matchedBy === 'in-reply-to' || opts.matchedBy === 'references'
              ? `imap:${msg.uid}`
              : `imap:${msg.uid}`,
          });
          if (ok) dropLead(lead);
          return { matched: ok, isAuto: true };
        }

        const ok = await markReplied(lead, opts);
        if (ok) {
          dropLead(lead);

          if (isAuto && !config.autoReplyHandlingEnabled) {
            try {
              await createNote(lead.lead_id, {
                type: 'auto_reply_candidate',
                content: `Reply LOOKS auto (${verdict.kind}, conf=${verdict.confidence.toFixed(2)}). Status kept as 'replied' because autoReplyHandlingEnabled=false.`,
                metadata: {
                  campaign_id: lead.campaign_id,
                  account: account.email,
                  matched_by: opts.matchedBy,
                  signals: verdict.signals,
                  confidence: verdict.confidence,
                  subject: opts.subject,
                },
              });
            } catch (e) {
              console.warn('[ImapReplyTracker] auto_reply_candidate note failed:', e instanceof Error ? e.message : e);
            }
          }
        }
        return { matched: ok, isAuto: false };
      };

      const markReplied = async (
        lead: LeadRef,
        opts: { fromAddr: string; subject: string; matchedBy: MatchStrategy },
      ): Promise<boolean> => {
        const { error: updateErr } = await supabase
          .from('campaign_leads')
          .update({ status: 'replied', replied_at: new Date().toISOString() })
          .eq('id', lead.id)
          .eq('status', 'sent');
        if (updateErr) return false;

        await updateLead(lead.lead_id, { outreach_status: 'replied' });
        await createNote(lead.lead_id, {
          type: 'email_replied',
          content: `Reply received via IMAP (${account.email}, matched by ${opts.matchedBy})`,
          metadata: { campaign_id: lead.campaign_id, from: opts.fromAddr, subject: opts.subject, matched_by: opts.matchedBy },
        });

        const { data: campaign } = await supabase
          .from('campaigns').select('total_replied').eq('id', lead.campaign_id).single();
        if (campaign) {
          await supabase
            .from('campaigns')
            .update({ total_replied: (campaign.total_replied || 0) + 1 })
            .eq('id', lead.campaign_id);
        }

        console.log(`[ImapReplyTracker] ${account.email}: reply from ${opts.fromAddr} (${opts.matchedBy}) → campaign_lead ${lead.id}`);
        return true;
      };

      // Fetch envelope (From, Subject, Message-ID, In-Reply-To) plus raw References header.
      // References isn't on the envelope so we ask for it explicitly.
      for await (const msg of client.fetch(uids, { envelope: true, uid: true, headers: ['references'] })) {
        scanned++;

        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';
        const subject  = msg.envelope?.subject ?? '';

        let lead: LeadRef | undefined;
        let matchedBy: MatchStrategy | null = null;

        // Strategy 1 — From-address match
        if (fromAddr) {
          lead = leadByEmail.get(fromAddr);
          if (lead) matchedBy = 'from';
        }

        // Strategy 2 — In-Reply-To header points at one of our outgoing Message-IDs
        if (!lead) {
          const irt = normalizeMessageId(msg.envelope?.inReplyTo);
          if (irt) {
            lead = leadByMessageId.get(irt);
            if (lead) matchedBy = 'in-reply-to';
          }
        }

        // Strategy 3 — References chain contains one of our outgoing Message-IDs
        if (!lead) {
          const refsHeader = msg.headers?.toString('utf8') ?? '';
          if (refsHeader) {
            const refs = refsHeader.match(/<[^<>]+>/g) ?? [];
            for (const ref of refs) {
              lead = leadByMessageId.get(normalizeMessageId(ref));
              if (lead) {
                matchedBy = 'references';
                break;
              }
            }
          }
        }

        if (!lead || !matchedBy) continue;

        const result = await handleMatch(lead, msg, {
          fromAddr: fromAddr || '(unknown)',
          subject,
          matchedBy,
        });

        if (result.matched) {
          if (result.isAuto) autoRepliesFound++;
          else repliesFound++;
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`[ImapReplyTracker] ${account.email} error:`, err instanceof Error ? err.message : err);
  } finally {
    if (connected) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }

  return { repliesFound, autoRepliesFound, scanned };
}

async function fetchSourceForUid(client: ImapFlow, uid: number): Promise<Buffer | null> {
  try {
    for await (const msg of client.fetch(String(uid), { uid: true, source: true }, { uid: true })) {
      if (msg.source) return msg.source as Buffer;
    }
  } catch (e) {
    console.warn('[ImapReplyTracker] fetchSourceForUid failed:', e instanceof Error ? e.message : e);
  }
  return null;
}

async function parseBody(raw: Buffer): Promise<{ headers: Record<string, string>; body: string }> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipHtmlToText: false });
  const headers: Record<string, string> = {};
  parsed.headerLines?.forEach((h) => {
    if (!h.key) return;
    // Last value wins (consistent with Gmail tracker). simpleParser splits the
    // header line so h.line includes "name: value\r\n".
    const colon = h.line.indexOf(':');
    if (colon === -1) return;
    headers[h.key.toLowerCase()] = h.line.slice(colon + 1).trim();
  });
  // Prefer text/plain; fall back to text/html stripped.
  const body = parsed.text || (parsed.html ? String(parsed.html) : '') || '';
  return { headers, body };
}

async function markAutoReplied(args: {
  lead: LeadRef;
  account: ImapAccount;
  classifier: ReturnType<typeof classifyReply>;
  opts: { fromAddr: string; subject: string; matchedBy: MatchStrategy };
  body: string;
  messageId: string;
}): Promise<boolean> {
  const { lead, account, classifier, opts, body, messageId } = args;
  const supabase = getSupabase();

  const { error: updateErr } = await supabase
    .from('campaign_leads')
    .update({ status: 'auto_replied', replied_at: new Date().toISOString() })
    .eq('id', lead.id)
    .eq('status', 'sent');
  if (updateErr) return false;

  // Increment campaign auto-reply counter (separate from total_replied)
  const { data: campaign } = await supabase
    .from('campaigns').select('total_auto_replied').eq('id', lead.campaign_id).single();
  if (campaign) {
    await supabase
      .from('campaigns')
      .update({ total_auto_replied: (campaign.total_auto_replied || 0) + 1 })
      .eq('id', lead.campaign_id);
  }

  // Audit note (always)
  await createNote(lead.lead_id, {
    type: 'auto_reply_received',
    content: `Auto-reply via IMAP (${account.email}, matched by ${opts.matchedBy}, kind=${classifier.kind}, conf=${classifier.confidence.toFixed(2)})`,
    metadata: {
      campaign_id: lead.campaign_id,
      account: account.email,
      from: opts.fromAddr,
      subject: opts.subject,
      matched_by: opts.matchedBy,
      kind: classifier.kind,
      confidence: classifier.confidence,
      signals: classifier.signals,
    },
  });

  // Pre-gate: extract; if empty, log + bail without touching discovered_contacts.
  const leadDomain = (lead.email_used ?? '').split('@')[1] ?? null;
  const { emails, urls } = extractContacts(body, {
    email_used: lead.email_used,
    lead_domain: leadDomain,
    // Filter out our own outreach domain — quoted From: lines in the
    // auto-reply body would otherwise self-extract as discoveries.
    sender_emails: account.email ? [account.email] : [],
  });

  if (emails.length === 0 && urls.length === 0) {
    await createNote(lead.lead_id, {
      type: 'auto_reply_no_contacts',
      content: 'Auto-reply contained no extractable contact emails or partner URLs — skipping discovery pipeline.',
      metadata: {
        campaign_id: lead.campaign_id,
        account: account.email,
        matched_by: opts.matchedBy,
      },
    });
    console.log(`[ImapReplyTracker] auto-reply on lead ${lead.lead_id} produced no candidates — pre-gated`);
    return true;
  }

  const auditMetadata = {
    from: opts.fromAddr,
    subject: opts.subject,
    matched_by: opts.matchedBy,
    account: account.email,
    kind: classifier.kind,
    confidence: classifier.confidence,
    signals: classifier.signals,
    discovered_at: new Date().toISOString(),
  };

  for (const candidate of emails) {
    await insertDiscoveredContact({
      lead_id: lead.lead_id,
      source_campaign_lead_id: lead.id,
      kind: 'email',
      value: candidate.value,
      role: candidate.role,
      score: candidate.score,
      auto_reply_message_id: messageId,
      auto_reply_metadata: auditMetadata,
    });
  }
  for (const candidate of urls) {
    await insertDiscoveredContact({
      lead_id: lead.lead_id,
      source_campaign_lead_id: lead.id,
      kind: 'url',
      value: candidate.value,
      role: candidate.signal,
      score: candidate.score,
      auto_reply_message_id: messageId,
      auto_reply_metadata: auditMetadata,
    });
  }

  console.log(
    `[ImapReplyTracker] ${account.email}: auto-reply on lead ${lead.lead_id} → ${emails.length} email + ${urls.length} URL candidate(s) queued`,
  );
  return true;
}

/**
 * Poll every active SMTP account that has IMAP credentials.
 *
 * Accounts are polled concurrently with a per-account hard timeout. Sequential
 * polling caused one stalled IMAP server (e.g. a Titan socket timeout) to
 * starve every account after it in the loop, leaving recent replies stuck in
 * 'sent' for hours. Promise.allSettled isolates failures.
 */
const PER_ACCOUNT_TIMEOUT_MS = 240_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export async function checkAllImapReplies(): Promise<{ accountsChecked: number; repliesFound: number; autoRepliesFound: number }> {
  const supabase = getSupabase();
  const { data: accounts } = await supabase
    .from('email_accounts')
    .select('id, email, imap_host, imap_port, imap_user, imap_pass')
    .eq('auth_type', 'smtp')
    .eq('status', 'active')
    .not('imap_host', 'is', null)
    .not('imap_user', 'is', null)
    .not('imap_pass', 'is', null);

  if (!accounts?.length) return { accountsChecked: 0, repliesFound: 0, autoRepliesFound: 0 };

  const results = await Promise.allSettled(
    accounts.map((acc) =>
      withTimeout(
        checkRepliesImap({
          id: acc.id,
          email: acc.email,
          imap_host: acc.imap_host,
          imap_port: acc.imap_port ?? 993,
          imap_user: acc.imap_user,
          imap_pass: acc.imap_pass,
        }),
        PER_ACCOUNT_TIMEOUT_MS,
        acc.email,
      ),
    ),
  );

  let totalReplies = 0;
  let totalAuto = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      totalReplies += r.value.repliesFound;
      totalAuto += r.value.autoRepliesFound;
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[ImapReplyTracker] ${accounts[i].email} skipped: ${reason}`);
    }
  }
  return { accountsChecked: accounts.length, repliesFound: totalReplies, autoRepliesFound: totalAuto };
}

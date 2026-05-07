/**
 * Inbox routes — reads real Gmail messages from all connected sending accounts.
 *
 * GET /api/inbox/accounts          → list connected Gmail account emails
 * GET /api/inbox/messages          → list messages (folder: inbox|sent|spam)
 * GET /api/inbox/thread/:threadId  → full thread with message bodies
 * POST /api/inbox/mark-read        → remove UNREAD label from a message
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapFlow } from 'imapflow';
import { getGmailClient, createGmailClientFromCredentials } from '../services/gmail-client.js';
import { fetchSmtpThread, searchImapThreadByEmail, invalidateThreadCache } from '../services/imap-thread-fetcher.js';
import { extractContacts } from '../services/auto-reply-extractor.js';
import { insertDiscoveredContact } from '../db/discovered-contacts.js';
import { renderAndSpin } from '../services/template-engine.js';
import { applyTestMode } from '../services/test-mode.js';
import { createNote } from '../db/notes.js';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';

const router = Router();

interface GmailClientEntry {
  email: string;
  gmail: ReturnType<typeof getGmailClient>;
}

/** Build Gmail clients for all active connected accounts (env + DB). */
async function getAllConnectedGmailClients(): Promise<GmailClientEntry[]> {
  const clients: GmailClientEntry[] = [];

  // Primary env account
  try {
    clients.push({ email: config.gmail.fromEmail.toLowerCase(), gmail: getGmailClient() });
  } catch {
    // Env account not configured — skip
  }

  // DB-stored OAuth accounts
  try {
    const { data: dbAccounts } = await getSupabase()
      .from('email_accounts')
      .select('email, gmail_client_id, gmail_client_secret, gmail_refresh_token')
      .eq('status', 'active')
      .not('gmail_refresh_token', 'is', null);

    for (const acc of dbAccounts ?? []) {
      if (!acc.gmail_refresh_token) continue;
      // Fall back to env Google OAuth credentials when account-specific ones weren't stored.
      // This is the normal case when the account was added via the app's own OAuth client
      // (the form's Client ID / Secret fields were left blank during OAuth popup flow).
      const clientId = acc.gmail_client_id || config.gmail.clientId;
      const clientSecret = acc.gmail_client_secret || config.gmail.clientSecret;
      if (!clientId || !clientSecret) continue;
      const email = (acc.email as string).toLowerCase();
      if (clients.some(c => c.email === email)) continue;
      clients.push({
        email,
        gmail: createGmailClientFromCredentials(clientId, clientSecret, acc.gmail_refresh_token),
      });
    }
  } catch {
    // DB unavailable — continue with env account only
  }

  return clients;
}

function parseHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

/** Strip outer HTML document wrapper — return only the <body> inner content. */
function extractBodyContent(rawHtml: string): string {
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1].trim();
  if (!rawHtml.trim().startsWith('<html')) return rawHtml;
  return rawHtml;
}

/** Convert plain text to simple HTML paragraphs for consistent rendering. */
function plainToHtml(plain: string): string {
  return plain
    .split(/\n\n+/)
    .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function extractBody(payload: any): { html: string; plain: string } {
  let html = '';
  let plain = '';
  // Collect inline image parts keyed by their Content-ID so we can rewrite
  // `<img src="cid:xxx">` to `data:` URIs — browsers can't resolve `cid:`.
  // Only parts with inline body.data are captured; large attachments returned
  // as attachmentId-only would require a second round trip (deferred).
  const cidMap = new Map<string, string>();

  function walk(part: any) {
    if (!part) return;
    if (part.mimeType === 'text/html' && part.body?.data) {
      html = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      plain = decodeBase64Url(part.body.data);
    } else if (part.mimeType?.startsWith('image/') && part.body?.data) {
      const headers = (part.headers ?? []) as { name?: string; value?: string }[];
      const cidHeader = headers.find(h => h.name?.toLowerCase() === 'content-id');
      const rawCid = cidHeader?.value;
      if (rawCid) {
        const cid = rawCid.replace(/^<|>$/g, '').trim().toLowerCase();
        if (cid) {
          // Gmail returns URL-safe base64; data URIs use standard base64.
          // Round-trip through Buffer to re-encode.
          const buf = Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
          cidMap.set(cid, `data:${part.mimeType};base64,${buf.toString('base64')}`);
        }
      }
    }
    if (part.parts) (part.parts as any[]).forEach(walk);
  }
  walk(payload);

  // Strip outer HTML document wrapper so Gmail's injected styles don't override our CSS
  if (html) html = extractBodyContent(html);
  // Rewrite cid: references to inline data URIs (broken images otherwise)
  if (html && cidMap.size > 0) {
    html = html.replace(/src=(["'])cid:([^"']+)\1/gi, (match, quote, cid) => {
      const dataUri = cidMap.get(cid.trim().toLowerCase());
      return dataUri ? `src=${quote}${dataUri}${quote}` : match;
    });
  }
  // If no HTML part, convert plain text to basic HTML paragraphs
  if (!html && plain) html = plainToHtml(plain);

  return { html, plain };
}

// ── GET /api/inbox/accounts ───────────────────────────────────────────────────
router.get('/accounts', async (_req: Request, res: Response) => {
  try {
    const clients = await getAllConnectedGmailClients();
    res.json({ success: true, data: clients.map(c => c.email) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/inbox/diagnostics ────────────────────────────────────────────────
// Returns all active email accounts and explains why each one can/cannot connect
// to the Gmail inbox API. Useful for debugging missing accounts.
router.get('/diagnostics', async (_req: Request, res: Response) => {
  try {
    const connectedClients = await getAllConnectedGmailClients();
    const connectedEmails = new Set(connectedClients.map(c => c.email));

    // Env account
    const envEntry: Record<string, unknown> = {
      email: config.gmail.fromEmail?.toLowerCase() || null,
      source: 'env',
      connected: config.gmail.fromEmail ? connectedEmails.has(config.gmail.fromEmail.toLowerCase()) : false,
      issue: config.gmail.fromEmail ? null : 'EMAIL_FROM env var not set',
    };

    // DB accounts
    const { data: dbAccounts } = await getSupabase()
      .from('email_accounts')
      .select('email, auth_type, status, gmail_client_id, gmail_client_secret, gmail_refresh_token')
      .eq('status', 'active');

    const dbEntries = (dbAccounts || []).map((acc: Record<string, unknown>) => {
      const email = (acc.email as string)?.toLowerCase();
      let issue: string | null = null;
      if (!acc.gmail_refresh_token) {
        issue = acc.auth_type === 'app_password'
          ? 'Account uses App Password — inbox requires Gmail OAuth. Re-add this account using "Connect with Google OAuth".'
          : 'Missing Gmail OAuth refresh token — re-connect this account via OAuth.';
      } else if (!acc.gmail_client_id) {
        issue = 'Missing Gmail Client ID — re-add account with OAuth credentials.';
      } else if (!acc.gmail_client_secret) {
        issue = 'Missing Gmail Client Secret — re-add account with OAuth credentials.';
      }
      return {
        email,
        source: 'db',
        auth_type: acc.auth_type,
        connected: !issue && connectedEmails.has(email),
        issue,
      };
    });

    res.json({
      success: true,
      data: [envEntry, ...dbEntries],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/inbox/messages?folder=inbox|sent|spam&limit=50 ───────────────────
router.get('/messages', async (req: Request, res: Response) => {
  const folder = (req.query.folder as string) || 'inbox';
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 100);

  const FOLDER_QUERY: Record<string, string> = {
    inbox: 'label:INBOX',
    sent:  'in:sent',
    spam:  'in:spam',
  };
  const q = FOLDER_QUERY[folder] ?? 'label:INBOX';

  try {
    const clients = await getAllConnectedGmailClients();
    if (clients.length === 0) {
      res.json({ success: true, data: [], accounts: [] });
      return;
    }

    const allMessages: any[] = [];

    await Promise.all(clients.map(async ({ email, gmail }) => {
      try {
        const listRes = await gmail.users.messages.list({
          userId: 'me',
          q,
          maxResults: limit,
        });

        const messageIds = listRes.data.messages ?? [];

        const msgs = await Promise.all(
          messageIds.map(async ({ id }: { id?: string | null }) => {
            if (!id) return null;
            try {
              const msgRes = await gmail.users.messages.get({
                userId: 'me',
                id,
                format: 'metadata',
                metadataHeaders: ['From', 'To', 'Subject', 'Date'],
              });
              const headers = (msgRes.data.payload?.headers ?? []) as { name: string; value: string }[];
              return {
                id: msgRes.data.id,
                threadId: msgRes.data.threadId,
                from: parseHeader(headers, 'From'),
                to: parseHeader(headers, 'To'),
                subject: parseHeader(headers, 'Subject'),
                date: parseHeader(headers, 'Date'),
                snippet: msgRes.data.snippet ?? '',
                unread: (msgRes.data.labelIds ?? []).includes('UNREAD'),
                labels: msgRes.data.labelIds ?? [],
                senderAccount: email,
              };
            } catch {
              return null;
            }
          })
        );

        allMessages.push(...msgs.filter(Boolean));
      } catch {
        // Account unavailable — skip silently
      }
    }));

    // Sort newest first
    allMessages.sort((a, b) => {
      const da = new Date(a.date).getTime() || 0;
      const db = new Date(b.date).getTime() || 0;
      return db - da;
    });

    res.json({
      success: true,
      data: allMessages.slice(0, limit),
      accounts: clients.map(c => c.email),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/inbox/thread/:threadId?account=email ────────────────────────────
router.get('/thread/:threadId', async (req: Request, res: Response) => {
  const { threadId } = req.params;
  const account = (req.query.account as string | undefined)?.toLowerCase();

  try {
    const clients = await getAllConnectedGmailClients();
    const entry = account
      ? (clients.find(c => c.email === account) ?? clients[0])
      : clients[0];

    if (!entry) {
      res.status(404).json({ success: false, error: 'No Gmail accounts connected' });
      return;
    }

    const threadRes = await (entry.gmail.users.threads.get as (params: Record<string, unknown>) => Promise<{ data: any }>)({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const messages = ((threadRes.data.messages ?? []) as any[]).map((msg: any) => {
      const headers = (msg.payload?.headers ?? []) as { name: string; value: string }[];
      const { html, plain } = extractBody(msg.payload);
      return {
        id: msg.id,
        threadId: msg.threadId,
        from: parseHeader(headers, 'From'),
        to: parseHeader(headers, 'To'),
        subject: parseHeader(headers, 'Subject'),
        date: parseHeader(headers, 'Date'),
        snippet: msg.snippet ?? '',
        body: html || plain,
        bodyType: html ? 'html' : 'plain',
        unread: (msg.labelIds ?? []).includes('UNREAD'),
        labels: msg.labelIds ?? [],
      };
    });

    res.json({
      success: true,
      data: { threadId, messages, senderAccount: entry.email },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/inbox/campaign-replies?folder=replies|sent ───────────────────────
// Returns campaign_leads enriched with lead + campaign info.
// folder=replies → status='replied'
// folder=sent    → status IN (sent, opened, replied, bounced)
//
// Joins against email_accounts so the frontend knows which thread endpoint to
// hit (Gmail API vs IMAP) and exposes reply_read_at so the notifications badge
// can track unseen replies.
router.get('/campaign-replies', async (req: Request, res: Response) => {
  const folder = (req.query.folder as string) || 'replies';
  // Both 'replied' (human) and 'auto_replied' (auto-detector flagged) belong
  // in the Replies folder. They look different in metrics — total_replied
  // stays human-only — but the user wants both visible in the inbox so a
  // "Prospect" badge can call out the ones that were promoted/auto-flagged.
  const statusFilter = folder === 'replies'
    ? ['replied', 'auto_replied']
    : ['sent', 'opened', 'replied', 'bounced', 'auto_replied'];
  const groupBy = req.query.groupBy as string | undefined;
  const campaignTypeFilter = req.query.campaignType as string | undefined;

  try {
    const { data, error } = await getSupabase()
      .from('campaign_leads')
      .select('id, campaign_id, lead_id, email_used, sender_email, status, sent_at, replied_at, reply_read_at, reply_snippet, gmail_thread_id, gmail_message_id, campaigns(name, campaign_type), leads(company_name, country)')
      .in('status', statusFilter)
      .order('sent_at', { ascending: false })
      .limit(400);

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    // is_prospect — true when the campaign_lead has at least one non-dismissed
    // discovered_contacts row. Drives the "Prospect" badge in the inbox UI so
    // the user can tell at a glance which replies they've already promoted.
    // One batched query keyed by source_campaign_lead_id keeps this O(1) per
    // page render regardless of message count.
    const campaignLeadIds = (data ?? []).map((r) => r.id as string).filter(Boolean);
    const prospectIds = new Set<string>();
    if (campaignLeadIds.length > 0) {
      const { data: discoveries } = await getSupabase()
        .from('discovered_contacts')
        .select('source_campaign_lead_id')
        .in('source_campaign_lead_id', campaignLeadIds)
        .in('status', ['pending_review', 'accepted', 'spawned_lead']);
      for (const d of discoveries ?? []) {
        if (d.source_campaign_lead_id) prospectIds.add(d.source_campaign_lead_id as string);
      }
    }

    // Resolve auth_type for each unique sender_email so the UI can branch on
    // Gmail vs SMTP without issuing a lookup per message.
    const senderEmails = Array.from(new Set(
      (data || []).map((r: Record<string, unknown>) => (r.sender_email as string | null)?.toLowerCase()).filter(Boolean),
    )) as string[];

    const authByEmail = new Map<string, string>();
    if (senderEmails.length > 0) {
      const { data: accounts } = await getSupabase()
        .from('email_accounts')
        .select('email, auth_type')
        .in('email', senderEmails);
      for (const a of accounts ?? []) {
        authByEmail.set((a.email as string).toLowerCase(), a.auth_type as string);
      }
    }

    const messages = (data || []).map((row: Record<string, unknown>) => {
      const sender = (row.sender_email as string | null)?.toLowerCase() ?? '';
      const authType = authByEmail.get(sender) ?? (sender ? 'gmail_oauth' : 'unknown');
      const campaign = row.campaigns as { name?: string; campaign_type?: string } | null;
      return {
        id: row.id,
        campaign_id: row.campaign_id,
        campaign_name: campaign?.name || 'Unknown Campaign',
        campaign_type: campaign?.campaign_type || 'outreach',
        lead_id: row.lead_id,
        company_name: (row.leads as { company_name?: string } | null)?.company_name || 'Unknown',
        country: (row.leads as { country?: string } | null)?.country || '',
        email_used: row.email_used,
        sender_email: row.sender_email,
        sender_auth_type: authType,  // 'gmail_oauth' | 'app_password' | 'smtp' | 'unknown'
        status: row.status,
        sent_at: row.sent_at,
        replied_at: row.replied_at,
        reply_read_at: row.reply_read_at,
        reply_snippet: row.reply_snippet,
        gmail_thread_id: row.gmail_thread_id,
        gmail_message_id: row.gmail_message_id,
        is_prospect: prospectIds.has(row.id as string),
      };
    });

    // Optional campaign_type filter (e.g. 'outreach' / 'discovery_followup') —
    // applied after the join so a single endpoint supports both feeds.
    const filtered = campaignTypeFilter
      ? messages.filter((m) => m.campaign_type === campaignTypeFilter)
      : messages;

    if (groupBy === 'campaign') {
      // Group flat messages by campaign_id so the frontend can render a
      // collapsible section per campaign with type badge + counts.
      const groups = new Map<string, {
        campaign_id: string;
        campaign_name: string;
        campaign_type: string;
        message_count: number;
        latest_at: string | null;
        messages: typeof filtered;
      }>();
      for (const msg of filtered) {
        const cid = String(msg.campaign_id);
        const g = groups.get(cid);
        if (g) {
          g.messages.push(msg);
          g.message_count++;
          const at = (msg.sent_at as string | null) ?? null;
          if (at && (!g.latest_at || at > g.latest_at)) g.latest_at = at;
        } else {
          groups.set(cid, {
            campaign_id: cid,
            campaign_name: msg.campaign_name,
            campaign_type: msg.campaign_type,
            message_count: 1,
            latest_at: (msg.sent_at as string | null) ?? null,
            messages: [msg],
          });
        }
      }
      // Default sort: most-recent campaign first
      const sorted = [...groups.values()].sort((a, b) =>
        (b.latest_at ?? '').localeCompare(a.latest_at ?? ''),
      );
      res.json({ success: true, data: { campaigns: sorted } });
      return;
    }

    res.json({ success: true, data: filtered });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/inbox/thread-smtp/:campaignLeadId ────────────────────────────────
// Resolves the campaign_lead → sender_email → IMAP creds, then reconstructs the
// conversation from the RFC822 Message-ID we stored at send time.
router.get('/thread-smtp/:campaignLeadId', async (req: Request, res: Response) => {
  const { campaignLeadId } = req.params;

  try {
    const supabase = getSupabase();
    const { data: cl, error: clErr } = await supabase
      .from('campaign_leads')
      .select('id, sender_email, gmail_message_id, email_used')
      .eq('id', campaignLeadId)
      .single();

    if (clErr || !cl) {
      res.status(404).json({ success: false, error: 'Campaign lead not found' });
      return;
    }
    if (!cl.sender_email) {
      res.status(400).json({ success: false, error: 'Send was not attributed to an account — cannot reconstruct thread' });
      return;
    }
    if (!cl.gmail_message_id) {
      res.status(400).json({ success: false, error: 'No Message-ID recorded for this send' });
      return;
    }

    const { data: account, error: accErr } = await supabase
      .from('email_accounts')
      .select('email, auth_type, imap_host, imap_port, imap_user, imap_pass')
      .eq('email', cl.sender_email)
      .eq('status', 'active')
      .single();

    if (accErr || !account) {
      res.status(404).json({ success: false, error: `Sender account ${cl.sender_email} not found or inactive` });
      return;
    }
    if (account.auth_type !== 'smtp') {
      res.status(400).json({ success: false, error: `Account ${cl.sender_email} is not SMTP/IMAP — use /inbox/thread/:threadId` });
      return;
    }
    if (!account.imap_host || !account.imap_user || !account.imap_pass) {
      res.status(400).json({ success: false, error: `Account ${cl.sender_email} has no IMAP credentials configured` });
      return;
    }

    const thread = await fetchSmtpThread(
      {
        imap_host: account.imap_host,
        imap_port: account.imap_port ?? 993,
        imap_user: account.imap_user,
        imap_pass: account.imap_pass,
      },
      cl.gmail_message_id,
      account.email,
      (cl.email_used as string | null) ?? undefined,
    );

    if (!thread) {
      res.status(404).json({ success: false, error: 'Could not locate message in mailbox (IMAP unreachable or message expired)' });
      return;
    }

    res.json({ success: true, data: thread });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/inbox/search-thread/:campaignLeadId ──────────────────────────────
// Universal fallback for rows that lack the IDs we need for the dedicated
// endpoints: no gmail_thread_id (so /thread/:threadId can't run) and/or no
// sender_email (so /thread-smtp/:id can't resolve an account). Scans every
// connected Gmail inbox + Sent and every IMAP/SMTP account for any message
// to or from the lead's email address, returns the most recent thread we can
// reconstruct. Handles the "legacy send before attribution existed" case.
router.get('/search-thread/:campaignLeadId', async (req: Request, res: Response) => {
  const { campaignLeadId } = req.params;

  try {
    const supabase = getSupabase();
    const { data: cl, error: clErr } = await supabase
      .from('campaign_leads')
      .select('id, email_used, lead_id, sender_email')
      .eq('id', campaignLeadId)
      .single();

    if (clErr || !cl) {
      res.status(404).json({ success: false, error: 'Campaign lead not found' });
      return;
    }

    // Prefer email_used (what we actually sent to); fall back to lead primary email
    let leadEmail = (cl.email_used as string | null)?.toLowerCase() ?? '';
    if (!leadEmail) {
      const { data: lead } = await supabase
        .from('leads')
        .select('primary_email, website_email, trustpilot_email')
        .eq('id', cl.lead_id)
        .single();
      leadEmail = (lead?.primary_email || lead?.website_email || lead?.trustpilot_email || '').toLowerCase();
    }

    if (!leadEmail) {
      res.status(400).json({ success: false, error: 'No email address recorded for this lead' });
      return;
    }

    // 1) Try every connected Gmail account
    const gmailClients = await getAllConnectedGmailClients();
    for (const { email, gmail } of gmailClients) {
      try {
        const q = `from:${leadEmail} OR to:${leadEmail}`;
        const listRes = await gmail.users.threads.list({ userId: 'me', q, maxResults: 1 });
        const threadId = listRes.data.threads?.[0]?.id;
        if (!threadId) continue;

        const threadRes = await (gmail.users.threads.get as (params: Record<string, unknown>) => Promise<{ data: any }>)({
          userId: 'me',
          id: threadId,
          format: 'full',
        });

        const messages = ((threadRes.data.messages ?? []) as any[]).map((msg: any) => {
          const headers = (msg.payload?.headers ?? []) as { name: string; value: string }[];
          const { html, plain } = extractBody(msg.payload);
          return {
            id: msg.id,
            threadId: msg.threadId,
            from: parseHeader(headers, 'From'),
            to: parseHeader(headers, 'To'),
            subject: parseHeader(headers, 'Subject'),
            date: parseHeader(headers, 'Date'),
            snippet: msg.snippet ?? '',
            body: html || plain,
            bodyType: html ? 'html' : 'plain',
            unread: (msg.labelIds ?? []).includes('UNREAD'),
            labels: msg.labelIds ?? [],
          };
        });

        res.json({ success: true, data: { threadId, messages, senderAccount: email } });
        return;
      } catch (e) {
        console.warn(`[search-thread] Gmail miss on ${email}:`, e instanceof Error ? e.message : e);
      }
    }

    // 2) Try every connected IMAP/SMTP account
    const { data: imapAccounts } = await supabase
      .from('email_accounts')
      .select('email, imap_host, imap_port, imap_user, imap_pass')
      .eq('auth_type', 'smtp')
      .eq('status', 'active')
      .not('imap_host', 'is', null)
      .not('imap_user', 'is', null)
      .not('imap_pass', 'is', null);

    for (const acc of imapAccounts ?? []) {
      const thread = await searchImapThreadByEmail(
        {
          imap_host: acc.imap_host,
          imap_port: acc.imap_port ?? 993,
          imap_user: acc.imap_user,
          imap_pass: acc.imap_pass,
        },
        leadEmail,
        acc.email,
      );
      if (thread && thread.messages.length > 0) {
        res.json({ success: true, data: thread });
        return;
      }
    }

    res.status(404).json({ success: false, error: `No thread found for ${leadEmail} in any connected mailbox` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/inbox/rendered-send/:campaignLeadId ──────────────────────────────
// Final fallback: when neither the live thread endpoints nor search-thread can
// locate the message (legacy sends without attribution, test-mode recipient
// rewrites, disconnected mailboxes), reconstruct a synthetic "thread" from the
// data we DO have — the stored campaign template rendered with the lead's
// tokens, plus the reply_snippet if one was captured. Guarantees the user
// always sees the outgoing content and any known reply, even when the live
// conversation is unreachable.
router.get('/rendered-send/:campaignLeadId', async (req: Request, res: Response) => {
  const { campaignLeadId } = req.params;

  try {
    const supabase = getSupabase();
    const { data: cl, error: clErr } = await supabase
      .from('campaign_leads')
      .select(`
        id, email_used, sender_email, sent_at, replied_at, reply_snippet, status,
        campaigns(name, template_subject, template_body),
        leads(company_name, website_url, star_rating, category, country, primary_email)
      `)
      .eq('id', campaignLeadId)
      .single();

    if (clErr || !cl) {
      res.status(404).json({ success: false, error: `Campaign lead not found: ${clErr?.message ?? 'no data'}` });
      return;
    }

    // Supabase's `.select(... campaigns(...), leads(...))` types these as
    // arrays-or-single depending on the join cardinality; at runtime both come
    // back as a single object, so normalize here.
    const campaignRaw = cl.campaigns as unknown;
    const campaign = (Array.isArray(campaignRaw) ? campaignRaw[0] : campaignRaw) as
      | { name?: string; template_subject?: string; template_body?: string }
      | null;
    const leadRaw = cl.leads as unknown;
    const lead = (Array.isArray(leadRaw) ? leadRaw[0] : leadRaw) as Record<string, unknown> | null;

    if (!campaign || !campaign.template_subject || !campaign.template_body) {
      res.status(404).json({ success: false, error: 'Campaign template not available' });
      return;
    }

    const subject = renderAndSpin(campaign.template_subject, lead ?? {});
    const body = renderAndSpin(campaign.template_body, lead ?? {});

    const messages: Array<{
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
    }> = [];

    // The outgoing message we actually sent (or would have sent)
    messages.push({
      id: `rendered:${cl.id}:out`,
      threadId: cl.id as string,
      from: (cl.sender_email as string) || '(sent account unknown)',
      to: (cl.email_used as string) || '(recipient unknown)',
      subject,
      date: (cl.sent_at as string) || new Date().toISOString(),
      snippet: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160),
      body,
      bodyType: 'html',
      unread: false,
      labels: ['rendered', 'sent'],
    });

    // The reply snippet the tracker captured, if any. Plain-text rendering —
    // we don't have the full reply body, just the first 200 chars.
    if (cl.status === 'replied' && cl.reply_snippet) {
      messages.push({
        id: `rendered:${cl.id}:reply`,
        threadId: cl.id as string,
        from: (cl.email_used as string) || '(reply sender)',
        to: (cl.sender_email as string) || '',
        subject: `Re: ${subject}`,
        date: (cl.replied_at as string) || new Date().toISOString(),
        snippet: cl.reply_snippet as string,
        body: String(cl.reply_snippet),
        bodyType: 'plain',
        unread: false,
        labels: ['rendered', 'reply'],
      });
    }

    res.json({
      success: true,
      data: {
        threadId: cl.id,
        messages,
        senderAccount: (cl.sender_email as string) || 'unknown',
        rendered: true,  // frontend flag — this is reconstructed, not live
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/inbox/notifications ──────────────────────────────────────────────
// Returns unread campaign replies for the notifications badge + TopBar dropdown.
// Unread = status='replied' AND reply_read_at IS NULL.
router.get('/notifications', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await getSupabase()
      .from('campaign_leads')
      .select('id, campaign_id, lead_id, sender_email, reply_snippet, replied_at, campaigns(name), leads(company_name)')
      .eq('status', 'replied')
      .is('reply_read_at', null)
      .order('replied_at', { ascending: false })
      .limit(20);

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    const items = (data || []).map((row: Record<string, unknown>) => ({
      id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: (row.campaigns as { name?: string } | null)?.name || 'Unknown Campaign',
      lead_id: row.lead_id,
      company_name: (row.leads as { company_name?: string } | null)?.company_name || 'Unknown',
      sender_email: row.sender_email,
      reply_snippet: row.reply_snippet,
      replied_at: row.replied_at,
    }));

    res.json({ success: true, data: { unreadCount: items.length, items } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/inbox/mark-replies-read ─────────────────────────────────────────
// Body: { ids?: string[] }  — IDs of campaign_leads to mark. Omit to mark all.
router.post('/mark-replies-read', async (req: Request, res: Response) => {
  const ids: string[] | undefined = Array.isArray(req.body?.ids) ? req.body.ids : undefined;
  const now = new Date().toISOString();

  try {
    let query = getSupabase()
      .from('campaign_leads')
      .update({ reply_read_at: now })
      .eq('status', 'replied')
      .is('reply_read_at', null);

    if (ids && ids.length > 0) {
      query = query.in('id', ids) as typeof query;
    }

    const { data: updated, error } = await query.select('id');
    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    res.json({ success: true, data: { marked: updated?.length ?? 0 } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/inbox/reply/:campaignLeadId ─────────────────────────────────────
// Send a direct reply on an existing outreach thread. Routes through the same
// sender account that was attributed to the campaign send, preserves RFC822
// threading (In-Reply-To + References) so Gmail/Titan groups the new message
// with the original conversation, and — for SMTP accounts — appends the sent
// copy to the mailbox's Sent folder so webmail mirrors it.
//
// Body: { body: string, subject?: string, replyToMessageId?: string }
// When replyToMessageId is provided, the reply threads under that specific
// message (In-Reply-To + trimmed References chain + quoted body of that
// message). Otherwise falls back to the latest inbound — which is what the
// UI defaults to when the user hasn't clicked a specific row.
router.post('/reply/:campaignLeadId', async (req: Request, res: Response) => {
  const { campaignLeadId } = req.params;
  const { body, subject: overrideSubject, replyToMessageId } = (req.body ?? {}) as {
    body?: string;
    subject?: string;
    replyToMessageId?: string;
  };

  if (!body || typeof body !== 'string' || !body.trim()) {
    res.status(400).json({ success: false, error: 'Reply body is required' });
    return;
  }

  try {
    const supabase = getSupabase();

    const { data: cl, error: clErr } = await supabase
      .from('campaign_leads')
      .select(`
        id, lead_id, campaign_id, sender_email, email_used, gmail_message_id, gmail_thread_id,
        campaigns(template_subject, name),
        leads(company_name, website_url, primary_email, category, country, star_rating)
      `)
      .eq('id', campaignLeadId)
      .single();

    if (clErr || !cl) {
      res.status(404).json({ success: false, error: 'Campaign lead not found' });
      return;
    }
    if (!cl.sender_email) {
      res.status(400).json({ success: false, error: 'No sender account attributed to this send' });
      return;
    }
    if (!cl.email_used) {
      res.status(400).json({ success: false, error: 'No recipient email on this send' });
      return;
    }

    // Case-insensitive lookup — campaign_leads.sender_email and
    // email_accounts.email can drift in case when the UI or DB migration
    // normalizes one side but not the other. Drop the status filter so we
    // can give a specific error (not-found vs paused) instead of a single
    // blanket "not found or inactive" message.
    const { data: acc, error: accErr } = await supabase
      .from('email_accounts')
      .select('email, status, auth_type, from_name, smtp_host, smtp_port, smtp_user, smtp_password, imap_host, imap_port, imap_user, imap_pass, gmail_client_id, gmail_client_secret, gmail_refresh_token')
      .ilike('email', cl.sender_email as string)
      .limit(1)
      .maybeSingle();

    if (accErr) {
      console.error(`[InboxReply] email_accounts lookup failed for ${cl.sender_email}:`, accErr.message);
      res.status(500).json({ success: false, error: `Account lookup failed: ${accErr.message}` });
      return;
    }
    if (!acc) {
      res.status(404).json({ success: false, error: `Sender account ${cl.sender_email} not found — may have been deleted or renamed` });
      return;
    }
    if (acc.status && acc.status !== 'active') {
      res.status(400).json({ success: false, error: `Sender account ${cl.sender_email} is ${acc.status} (not active). Re-enable it on the Email Accounts page.` });
      return;
    }

    // Subject resolution: prefer explicit override → rendered campaign subject → fallback
    const campaign = (Array.isArray(cl.campaigns) ? cl.campaigns[0] : cl.campaigns) as
      | { template_subject?: string; name?: string }
      | null;
    const lead = (Array.isArray(cl.leads) ? cl.leads[0] : cl.leads) as Record<string, unknown> | null;

    let subject = overrideSubject;
    if (!subject) {
      const tpl = campaign?.template_subject
        ? renderAndSpin(campaign.template_subject, lead ?? {})
        : (campaign?.name ?? 'your message');
      subject = /^re:\s/i.test(tpl) ? tpl : `Re: ${tpl}`;
    }

    const originalMsgId = (cl.gmail_message_id as string | null) ?? null;
    const authType = acc.auth_type as string;
    const senderEmailLower = (acc.email as string).toLowerCase();

    // ── Thread-aware reply-chain construction ─────────────────────────────
    // Gmail's threading engine (and Outlook's, and most clients) groups a
    // reply with its conversation when three things line up:
    //   1. Subject matches (the "Re:" prefix is already handled above)
    //   2. In-Reply-To points to the latest message in the conversation
    //   3. References contains the full breadcrumb trail
    // If In-Reply-To points only at the original outgoing (our first
    // campaign send), the recipient's client frequently fails to thread
    // and starts a brand-new conversation — which is exactly what was
    // happening before this fix. We fetch the thread here so we can pick
    // the *latest inbound* Message-ID for In-Reply-To and build the full
    // References chain. The 60s in-memory cache on fetchSmtpThread keeps
    // this cheap when the user just viewed the thread.
    // Default chain: just the original outgoing Message-ID, properly angle-
    // wrapped. Gets replaced below with the full thread chain when we can
    // fetch it.
    let inReplyTo: string | null = originalMsgId;
    let referencesHeader: string | null = originalMsgId
      ? `<${originalMsgId.replace(/^<|>$/g, '')}>`
      : null;
    let quotedHtml = '';

    if ((authType === 'smtp' || authType === 'app_password') && originalMsgId) {
      const imapHost = acc.imap_host as string | null;
      const imapUser = acc.imap_user as string | null;
      const imapPass = acc.imap_pass as string | null;
      if (imapHost && imapUser && imapPass) {
        try {
          const thread = await fetchSmtpThread(
            { imap_host: imapHost, imap_port: (acc.imap_port as number | null) ?? 993, imap_user: imapUser, imap_pass: imapPass },
            originalMsgId,
            acc.email as string,
            cl.email_used as string,
          );
          if (thread && thread.messages.length > 0) {
            // Target selection: user-clicked message wins; otherwise default to
            // the latest inbound so the behavior matches "reply to the prospect".
            // If the provided ID isn't in the thread (stale UI state), silently
            // fall back to latestInbound instead of failing the send.
            const targetedId = replyToMessageId?.trim();
            const targeted = targetedId
              ? thread.messages.find((m) => m.id === targetedId)
              : undefined;
            // Diagnostic log — shows what the client pinned and whether the
            // server found it in the fetched thread. Grep Cloud Run logs for
            // "[InboxReply] target" to verify click-to-target is wiring through.
            console.log('[InboxReply] target resolution:', JSON.stringify({
              clientPinned: targetedId ?? null,
              threadMessageIds: thread.messages.map((m) => m.id),
              foundInThread: !!targeted,
            }));
            const inbound = thread.messages.filter((m) => {
              const addr = m.from.match(/<([^>]+)>/)?.[1] ?? m.from;
              return addr.toLowerCase() !== senderEmailLower;
            });
            const latestInbound = inbound[inbound.length - 1];
            const target = targeted ?? latestInbound;
            if (target?.id) inReplyTo = target.id;
            // References = chain up to AND INCLUDING the targeted message.
            // Including messages after the target would imply we're replying
            // to something later than we actually are — semantically wrong
            // and confuses some clients. Format per RFC 2822 §3.6.4: each
            // Message-ID in its own angle brackets, single-space separated.
            const targetIdx = target ? thread.messages.findIndex((m) => m.id === target.id) : -1;
            const chainSource = targetIdx >= 0
              ? thread.messages.slice(0, targetIdx + 1)
              : thread.messages;
            const chain = chainSource
              .map((m) => m.id)
              .filter((id): id is string => !!id && !id.startsWith('rendered:') && !id.includes(':'))
              .map((id) => `<${id.replace(/^<|>$/g, '')}>`);
            if (chain.length > 0) referencesHeader = chain.join(' ');
            console.log('[InboxReply] final threading:', JSON.stringify({
              inReplyTo,
              references: referencesHeader,
              usedClientPin: !!targeted,
              targetFrom: target?.from ?? null,
              targetDate: target?.date ?? null,
              chainLength: chain.length,
            }));
            // Quote the target message (clicked or latestInbound fallback).
            if (target) {
              const quoteDate = (() => {
                try {
                  return new Date(target.date).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
                } catch { return target.date; }
              })();
              const quoteText = target.bodyType === 'html'
                ? target.body.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                : target.body;
              const quoteSnippet = quoteText.slice(0, 600) + (quoteText.length > 600 ? '…' : '');
              quotedHtml = `
<br>
<div style="color:#555;font-size:12px;border-left:3px solid #ddd;padding-left:12px;margin-top:24px;font-family:Arial,sans-serif;">
  <p style="margin:0 0 8px;color:#888;">On ${quoteDate}, ${escapeHtmlFragment(target.from)} wrote:</p>
  <p style="margin:0;white-space:pre-wrap;">${escapeHtmlFragment(quoteSnippet)}</p>
</div>`;
            }
          }
        } catch (e) {
          console.warn('[InboxReply] thread-fetch for headers failed, falling back to original Message-ID chain:', e instanceof Error ? e.message : e);
        }
      }
    }

    // Gmail OAuth path doesn't fetch the thread above (it relies on Gmail's
    // own threading via the threadId parameter), so if the frontend pinned a
    // specific replyToMessageId, honor it here as a direct In-Reply-To
    // override. Gmail will still group the reply via threadId; the override
    // just makes the "In-Reply-To" header point at the specific message the
    // user clicked instead of the original campaign send.
    if (authType === 'gmail_oauth' && replyToMessageId?.trim()) {
      inReplyTo = replyToMessageId.trim();
    }

    // Escape then linewrap — plain text composer body → HTML paragraphs,
    // followed by the quoted original if we found one.
    const escaped = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const userHtml = escaped
      .split(/\n\n+/)
      .map((p) => `<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;">${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
    const htmlBody = userHtml + quotedHtml;

    // Apply test-mode redirect so Inbox replies respect the same safety net as campaigns
    const testApplied = applyTestMode({ to: cl.email_used as string, subject, html: htmlBody });

    let result: { success: boolean; messageId?: string; error?: string };
    if (authType === 'smtp' || authType === 'app_password') {
      result = await sendSmtpReply({
        account: acc as Record<string, unknown>,
        to: testApplied.to,
        subject: testApplied.subject,
        html: testApplied.html,
        inReplyTo,
        references: referencesHeader,
      });
    } else if (authType === 'gmail_oauth') {
      result = await sendGmailReply({
        account: acc as Record<string, unknown>,
        to: testApplied.to,
        subject: testApplied.subject,
        html: testApplied.html,
        inReplyTo,
        references: referencesHeader,
        threadId: (cl.gmail_thread_id as string | null) ?? null,
      });
    } else {
      res.status(400).json({ success: false, error: `Unsupported account auth_type: ${authType}` });
      return;
    }

    if (!result.success) {
      res.status(500).json({ success: false, error: result.error ?? 'Send failed' });
      return;
    }

    // Invalidate the in-memory thread cache for this account so the next GET
    // picks up the freshly-appended Sent copy instead of serving a 60-second
    // stale snapshot.
    invalidateThreadCache(cl.sender_email as string);

    try {
      await createNote(cl.lead_id as string, {
        type: 'email_replied_manually',
        content: `Manual reply sent via Inbox composer`,
        metadata: {
          campaign_id: cl.campaign_id,
          to: testApplied.to,
          subject: testApplied.subject,
          message_id: result.messageId,
          body_preview: body.slice(0, 200),
          test_mode: config.testMode.enabled,
        },
      });
    } catch (e) {
      console.warn('[InboxReply] lead_note failed:', e instanceof Error ? e.message : e);
    }

    // Return a fully-formed message object so the frontend can inject it into
    // the thread immediately, without waiting for the IMAP Sent-folder append
    // to propagate. The subsequent IMAP refetch then supplies the authoritative
    // server copy (same Message-ID, so our dedup collapses them).
    const nowIso = new Date().toISOString();
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 160);
    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        to: testApplied.to,
        subject: testApplied.subject,
        testMode: config.testMode.enabled,
        message: {
          id: result.messageId || `local:${Date.now()}`,
          threadId: originalMsgId ?? (cl.gmail_thread_id as string | null) ?? '',
          from: `${(acc.from_name as string | null) ?? 'OptiRate'} <${acc.email as string}>`,
          to: testApplied.to,
          subject: testApplied.subject,
          date: nowIso,
          snippet,
          body: testApplied.html,
          bodyType: 'html',
          unread: false,
          labels: ['Sent'],
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[InboxReply] error:', message);
    res.status(500).json({ success: false, error: message });
  }
});

function ensureAngles(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim().replace(/^<|>$/g, '');
  return trimmed ? `<${trimmed}>` : null;
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function escapeHtmlFragment(raw: string): string {
  // Decode first so already-encoded source text doesn't end up double-escaped.
  // The IMAP body often arrives with &#39; for apostrophes etc.; without this
  // step the quoted block renders "I&amp;#39;m" literally for the reader.
  return decodeHtmlEntities(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Promise race with a timeout — resolves undefined when the operation exceeds
 *  the budget so the caller can continue without waiting indefinitely. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => {
      console.warn(`[InboxReply] ${label} exceeded ${ms}ms — continuing without awaiting`);
      resolve(undefined);
    }, ms)),
  ]);
}

async function sendSmtpReply(params: {
  account: Record<string, unknown>;
  to: string;
  subject: string;
  html: string;
  inReplyTo: string | null;
  references: string | null;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const acc = params.account;
  const smtpHost = acc.smtp_host as string | null;
  const smtpPort = (acc.smtp_port as number | null) ?? 587;
  const smtpUser = (acc.smtp_user as string | null) ?? (acc.email as string);
  const smtpPass = acc.smtp_password as string | null;
  const email = acc.email as string;
  const fromName = (acc.from_name as string | null) ?? 'OptiRate';

  if (!smtpHost || !smtpPass) {
    return { success: false, error: 'SMTP credentials missing on sender account' };
  }

  const secure = smtpPort === 465;
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const hostPart = email.split('@')[1] || 'localhost';
  const messageId = `<${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}@${hostPart}>`;

  const headers: Record<string, string> = {};
  const irt = ensureAngles(params.inReplyTo);
  // params.references is already a properly-formatted "<A> <B>" chain built
  // by the caller — do NOT call ensureAngles on it (which would collapse
  // multiple IDs into a single malformed "<A B>" wrapper).
  if (irt) headers['In-Reply-To'] = irt;
  if (params.references) headers['References'] = params.references;
  console.log('[InboxReply][SMTP] outbound headers:', JSON.stringify({
    messageId,
    inReplyTo: headers['In-Reply-To'] ?? null,
    references: headers['References'] ?? null,
    to: params.to,
    subject: params.subject,
  }));

  const mailOptions: nodemailer.SendMailOptions = {
    from: `"${fromName}" <${email}>`,
    to: params.to,
    subject: params.subject,
    html: params.html,
    messageId,
    headers,
  };

  try {
    await transporter.sendMail(mailOptions);

    const imapHost = acc.imap_host as string | null;
    const imapUser = acc.imap_user as string | null;
    const imapPass = acc.imap_pass as string | null;
    if (imapHost && imapUser && imapPass) {
      // Await with 5-second timeout: the user's send is already safely on
      // the wire by this point, so the worst case is a quieter logline if
      // IMAP is slow. Success guarantees the Sent folder has our copy
      // before the frontend re-renders the thread.
      await withTimeout(
        appendReplyToSent(
          { imap_host: imapHost, imap_port: (acc.imap_port as number | null) ?? 993, imap_user: imapUser, imap_pass: imapPass },
          mailOptions,
          email,
        ).catch((err) => {
          console.warn(`[InboxReply→IMAP] append to Sent failed for ${email}:`, err instanceof Error ? err.message : err);
        }),
        5000,
        `IMAP append to Sent for ${email}`,
      );
    }

    return { success: true, messageId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function appendReplyToSent(
  auth: { imap_host: string; imap_port: number; imap_user: string; imap_pass: string },
  mailOptions: nodemailer.SendMailOptions,
  email: string,
): Promise<void> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, msg) => {
      if (err) reject(err);
      else resolve(msg);
    });
  });

  const client = new ImapFlow({
    host: auth.imap_host,
    port: auth.imap_port,
    secure: true,
    auth: { user: auth.imap_user, pass: auth.imap_pass },
    logger: false,
    connectionTimeout: 10000,
  });

  try {
    await client.connect();
    const mailboxes = await client.list();
    const sentBox =
      mailboxes.find((b) => b.specialUse === '\\Sent') ??
      mailboxes.find((b) => /^sent$/i.test(b.name)) ??
      mailboxes.find((b) => /^sent.messages$/i.test(b.name)) ??
      mailboxes.find((b) => /sent/i.test(b.name));
    if (!sentBox) {
      console.warn(`[InboxReply→IMAP] no Sent folder on ${auth.imap_host} for ${email}`);
      return;
    }
    await client.append(sentBox.path, raw, ['\\Seen']);
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

async function sendGmailReply(params: {
  account: Record<string, unknown>;
  to: string;
  subject: string;
  html: string;
  inReplyTo: string | null;
  references: string | null;
  threadId: string | null;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const acc = params.account;
  const clientId = (acc.gmail_client_id as string | null) ?? config.gmail?.clientId ?? null;
  const clientSecret = (acc.gmail_client_secret as string | null) ?? config.gmail?.clientSecret ?? null;
  const refreshToken = acc.gmail_refresh_token as string | null;
  const email = acc.email as string;
  const fromName = (acc.from_name as string | null) ?? 'OptiRate';

  if (!clientId || !clientSecret || !refreshToken) {
    return { success: false, error: 'Gmail OAuth credentials missing on sender account' };
  }

  const gmail = createGmailClientFromCredentials(clientId, clientSecret, refreshToken);
  const senderDomain = email.split('@')[1] || 'gmail.com';
  const messageId = `<${crypto.randomUUID()}@${senderDomain}>`;

  const headers: Record<string, string> = {
    'List-Unsubscribe': `<mailto:${email}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  const irt = ensureAngles(params.inReplyTo);
  // Same rule as SMTP — References is already correctly angle-wrapped by the
  // caller; ensureAngles here would break a multi-ID chain.
  if (irt) headers['In-Reply-To'] = irt;
  if (params.references) headers['References'] = params.references;

  const mailOptions: Record<string, unknown> = {
    from: `"${fromName}" <${email}>`,
    to: params.to,
    subject: params.subject,
    html: params.html,
    messageId,
    headers,
  };

  try {
    const raw = await new Promise<string>((resolve, reject) => {
      new MailComposer(mailOptions).compile().build((err, msg) => {
        if (err) return reject(err);
        resolve(msg.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
      });
    });

    const body: Record<string, unknown> = { raw };
    if (params.threadId) body.threadId = params.threadId;

    await (gmail.users.messages.send as (args: Record<string, unknown>) => Promise<unknown>)({
      userId: 'me',
      requestBody: body,
    });

    return { success: true, messageId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── POST /api/inbox/mark-read — body: { messageId, account } ─────────────────
router.post('/mark-read', async (req: Request, res: Response) => {
  const { messageId, account } = req.body;
  if (!messageId) {
    res.status(400).json({ success: false, error: 'messageId required' });
    return;
  }

  try {
    const clients = await getAllConnectedGmailClients();
    const entry = account
      ? (clients.find(c => c.email === (account as string).toLowerCase()) ?? clients[0])
      : clients[0];

    if (!entry) {
      res.status(404).json({ success: false, error: 'No Gmail accounts connected' });
      return;
    }

    await entry.gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });

    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/inbox/promote-to-prospects ──────────────────────────────────────
// User selects replies from the inbox, clicks "Promote to Prospects". For each:
//   1. Fetch the inbound reply body (Gmail thread or SMTP/IMAP reconstruction).
//   2. Run the auto-reply extractor — pulls candidate emails + URLs.
//   3. Insert each candidate into discovered_contacts (status=pending_review).
//   4. Flip the source campaign_leads row to status='auto_replied' so it
//      drops out of "Human Replies" and feeds the Prospects list.
//   5. PAUSE the lead's follow-up sequence on every campaign_leads row that
//      lead participates in — the user is creating a fresh discovery follow-up
//      campaign manually and doesn't want the cold sequence still firing.
//
// The Discovery worker (server/src/jobs/process-discovered-contacts.ts) picks
// up the queued rows on its next 5-min tick: it verifies emails through the
// layered validator and runs scrape_website.py against URLs to harvest more
// emails. The user sees the candidate land on /prospects, then Accepts to
// promote to leads.discovered_email.
router.post('/promote-to-prospects', async (req: Request, res: Response) => {
  try {
    const ids = Array.isArray(req.body?.campaignLeadIds) ? (req.body.campaignLeadIds as string[]) : [];
    if (ids.length === 0) {
      res.status(400).json({ success: false, error: 'campaignLeadIds (non-empty array) is required' });
      return;
    }
    if (ids.length > 50) {
      res.status(400).json({ success: false, error: 'Cap is 50 promotions per call — split into batches' });
      return;
    }

    const supabase = getSupabase();

    const { data: rows, error: rowsErr } = await supabase
      .from('campaign_leads')
      .select('id, lead_id, campaign_id, email_used, sender_email, gmail_thread_id, gmail_message_id')
      .in('id', ids);
    if (rowsErr) throw new Error(rowsErr.message);
    if (!rows || rows.length === 0) {
      res.json({ success: true, data: { promoted: 0, candidatesQueued: 0, results: [] } });
      return;
    }

    // Resolve each sender's auth_type so we know whether to fetch via Gmail
    // API or IMAP. Single batched lookup, indexed by sender_email.
    const senderEmails = Array.from(new Set(
      rows.map((r) => (r.sender_email as string | null)?.toLowerCase()).filter(Boolean) as string[],
    ));
    const accountByEmail = new Map<string, { auth_type: string; imap_host: string | null; imap_port: number | null; imap_user: string | null; imap_pass: string | null; gmail_client_id: string | null; gmail_client_secret: string | null; gmail_refresh_token: string | null; }>();
    if (senderEmails.length > 0) {
      const { data: accounts } = await supabase
        .from('email_accounts')
        .select('email, auth_type, imap_host, imap_port, imap_user, imap_pass, gmail_client_id, gmail_client_secret, gmail_refresh_token')
        .in('email', senderEmails);
      for (const a of accounts ?? []) {
        accountByEmail.set((a.email as string).toLowerCase(), a as never);
      }
    }

    const results: Array<{ campaign_lead_id: string; status: 'queued' | 'no_body' | 'no_candidates' | 'error'; emailsQueued: number; urlsQueued: number; error?: string }> = [];
    let totalCandidates = 0;
    let promotedCount = 0;

    for (const row of rows) {
      const cl = row as {
        id: string; lead_id: string; campaign_id: string;
        email_used: string | null; sender_email: string | null;
        gmail_thread_id: string | null; gmail_message_id: string | null;
      };
      try {
        const body = await fetchInboundReplyBody(cl, accountByEmail);
        if (!body) {
          results.push({ campaign_lead_id: cl.id, status: 'no_body', emailsQueued: 0, urlsQueued: 0 });
          continue;
        }

        const leadDomain = (cl.email_used ?? '').split('@')[1] ?? null;
        const { emails, urls } = extractContacts(body.text, {
          email_used: cl.email_used,
          lead_domain: leadDomain,
        });

        if (emails.length === 0 && urls.length === 0) {
          results.push({ campaign_lead_id: cl.id, status: 'no_candidates', emailsQueued: 0, urlsQueued: 0 });
          continue;
        }

        const auditMetadata = {
          subject: body.subject,
          snippet: body.text.slice(0, 200),
          source: 'inbox-promote',
          discovered_at: new Date().toISOString(),
        };

        for (const c of emails) {
          await insertDiscoveredContact({
            lead_id: cl.lead_id,
            source_campaign_lead_id: cl.id,
            kind: 'email',
            value: c.value,
            role: c.role,
            score: c.score,
            auto_reply_message_id: cl.gmail_message_id ?? cl.gmail_thread_id ?? null,
            auto_reply_metadata: auditMetadata,
          });
        }
        for (const c of urls) {
          await insertDiscoveredContact({
            lead_id: cl.lead_id,
            source_campaign_lead_id: cl.id,
            kind: 'url',
            value: c.value,
            role: c.signal,
            score: c.score,
            auto_reply_message_id: cl.gmail_message_id ?? cl.gmail_thread_id ?? null,
            auto_reply_metadata: auditMetadata,
          });
        }

        // Pause every sequence row for this lead so the cold follow-up
        // cadence doesn't keep firing — the user will create a new discovery
        // follow-up campaign manually for this prospect. We deliberately do
        // NOT flip campaign_leads.status to 'auto_replied' on manual promote:
        // the user wants the reply to stay visible in the Inbox > Replies
        // folder with a "Prospect" badge so they can revisit it (especially
        // when the source URL turns out to be unscrapeable). The badge is
        // driven by the existence of any non-dismissed discovered_contacts
        // row pointing back at this campaign_lead — see /inbox/campaign-replies.
        await supabase
          .from('campaign_leads')
          .update({ sequence_paused: true, next_step_at: null })
          .eq('lead_id', cl.lead_id);

        await createNote(cl.lead_id, {
          type: 'auto_reply_received',
          content: `Manually promoted from Inbox — ${emails.length} email + ${urls.length} URL candidate(s) queued. Cold sequences paused.`,
          metadata: {
            campaign_id: cl.campaign_id,
            source_campaign_lead_id: cl.id,
            promoted_by: 'inbox-button',
            email_count: emails.length,
            url_count: urls.length,
          },
        });

        results.push({ campaign_lead_id: cl.id, status: 'queued', emailsQueued: emails.length, urlsQueued: urls.length });
        totalCandidates += emails.length + urls.length;
        promotedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[promote-to-prospects] ${cl.id} failed:`, msg);
        results.push({ campaign_lead_id: cl.id, status: 'error', emailsQueued: 0, urlsQueued: 0, error: msg });
      }
    }

    res.json({
      success: true,
      data: {
        promoted: promotedCount,
        candidatesQueued: totalCandidates,
        results,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * Fetch the latest inbound reply body for a given campaign_lead. Tries Gmail
 * thread first when the lead has gmail_thread_id + a Gmail account, falls
 * back to IMAP thread reconstruction for SMTP accounts. Returns the latest
 * inbound message's plain body + subject, or null when nothing is reachable.
 *
 * The returned `text` is what the auto-reply extractor scans — HTML is
 * tolerable (the extractor's regexes work on tags-stripped content), but
 * plain text is preferred when available.
 */
async function fetchInboundReplyBody(
  cl: { id: string; sender_email: string | null; gmail_thread_id: string | null; gmail_message_id: string | null; email_used: string | null },
  accountByEmail: Map<string, { auth_type: string; imap_host: string | null; imap_port: number | null; imap_user: string | null; imap_pass: string | null; gmail_client_id: string | null; gmail_client_secret: string | null; gmail_refresh_token: string | null }>,
): Promise<{ text: string; subject: string } | null> {
  const sender = cl.sender_email?.toLowerCase() ?? '';
  const account = sender ? accountByEmail.get(sender) : undefined;

  // ── Gmail path ──────────────────────────────────────────────────────
  if (cl.gmail_thread_id && (!account || account.auth_type === 'gmail_oauth' || account.auth_type === 'app_password')) {
    try {
      const gmail = account?.gmail_refresh_token
        ? createGmailClientFromCredentials(
            account.gmail_client_id || config.gmail.clientId,
            account.gmail_client_secret || config.gmail.clientSecret,
            account.gmail_refresh_token,
          )
        : getGmailClient();

      const threadRes = await gmail.users.threads.get({
        userId: 'me',
        id: cl.gmail_thread_id,
        format: 'full',
      });

      const messages = threadRes.data.messages ?? [];
      const senderAddr = (sender || config.gmail.fromEmail).toLowerCase();
      // Pick the latest inbound (not from sender) — most recent reply wins
      // when the conversation has multiple inbound messages.
      const inbound = [...messages].reverse().find((msg) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const headers = ((msg.payload as any)?.headers ?? []) as { name?: string; value?: string }[];
        const fromHdr = headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? '';
        return !fromHdr.toLowerCase().includes(senderAddr);
      });
      if (!inbound) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const headers = ((inbound.payload as any)?.headers ?? []) as { name?: string; value?: string }[];
      const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '';
      const { html, plain } = extractBody(inbound.payload);
      return { text: plain || html || (inbound.snippet ?? ''), subject };
    } catch (e) {
      console.warn('[promote-to-prospects] Gmail fetch failed:', e instanceof Error ? e.message : e);
      return null;
    }
  }

  // ── IMAP path ───────────────────────────────────────────────────────
  if (account?.auth_type === 'smtp' && account.imap_host && account.imap_user && account.imap_pass) {
    try {
      const auth = {
        imap_host: account.imap_host,
        imap_port: account.imap_port ?? 993,
        imap_user: account.imap_user,
        imap_pass: account.imap_pass,
      };
      let thread = null;
      if (cl.gmail_message_id) {
        thread = await fetchSmtpThread(auth, cl.gmail_message_id, sender, cl.email_used ?? undefined);
      }
      if (!thread && cl.email_used) {
        thread = await searchImapThreadByEmail(auth, cl.email_used, sender);
      }
      if (!thread || thread.messages.length === 0) return null;
      // Latest inbound = highest date with `from` not equal to the sender account
      const inbound = [...thread.messages].reverse().find((m) => {
        const fromAddr = (m.from || '').toLowerCase();
        return !fromAddr.includes(sender);
      });
      if (!inbound) return null;
      // ThreadMessage.body is HTML; the extractor strips tags internally.
      return { text: inbound.body, subject: inbound.subject };
    } catch (e) {
      console.warn('[promote-to-prospects] IMAP fetch failed:', e instanceof Error ? e.message : e);
      return null;
    }
  }

  return null;
}

export default router;

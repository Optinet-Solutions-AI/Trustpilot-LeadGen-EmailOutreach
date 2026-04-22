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
  const statusFilter = folder === 'replies'
    ? ['replied']
    : ['sent', 'opened', 'replied', 'bounced'];

  try {
    const { data, error } = await getSupabase()
      .from('campaign_leads')
      .select('id, campaign_id, lead_id, email_used, sender_email, status, sent_at, replied_at, reply_read_at, reply_snippet, gmail_thread_id, gmail_message_id, campaigns(name), leads(company_name, country)')
      .in('status', statusFilter)
      .order('sent_at', { ascending: false })
      .limit(200);

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
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
      return {
        id: row.id,
        campaign_id: row.campaign_id,
        campaign_name: (row.campaigns as { name?: string } | null)?.name || 'Unknown Campaign',
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
      };
    });

    res.json({ success: true, data: messages });
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
// Body: { body: string, subject?: string, includeQuote?: boolean }
router.post('/reply/:campaignLeadId', async (req: Request, res: Response) => {
  const { campaignLeadId } = req.params;
  const { body, subject: overrideSubject } = (req.body ?? {}) as { body?: string; subject?: string };

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

    // Escape then linewrap — plain text composer body → HTML paragraphs
    const escaped = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const htmlBody = escaped
      .split(/\n\n+/)
      .map((p) => `<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;">${p.replace(/\n/g, '<br>')}</p>`)
      .join('');

    // Apply test-mode redirect so Inbox replies respect the same safety net as campaigns
    const testApplied = applyTestMode({ to: cl.email_used as string, subject, html: htmlBody });

    const originalMsgId = (cl.gmail_message_id as string | null) ?? null;
    const authType = acc.auth_type as string;

    let result: { success: boolean; messageId?: string; error?: string };
    if (authType === 'smtp' || authType === 'app_password') {
      result = await sendSmtpReply({
        account: acc as Record<string, unknown>,
        to: testApplied.to,
        subject: testApplied.subject,
        html: testApplied.html,
        inReplyTo: originalMsgId,
        references: originalMsgId,
      });
    } else if (authType === 'gmail_oauth') {
      result = await sendGmailReply({
        account: acc as Record<string, unknown>,
        to: testApplied.to,
        subject: testApplied.subject,
        html: testApplied.html,
        inReplyTo: originalMsgId,
        references: originalMsgId,
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
  const refs = ensureAngles(params.references);
  if (irt) headers['In-Reply-To'] = irt;
  if (refs) headers['References'] = refs;

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
      appendReplyToSent(
        { imap_host: imapHost, imap_port: (acc.imap_port as number | null) ?? 993, imap_user: imapUser, imap_pass: imapPass },
        mailOptions,
        email,
      ).catch((err) => console.warn(`[InboxReply→IMAP] append to Sent failed for ${email}:`, err instanceof Error ? err.message : err));
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
  const refs = ensureAngles(params.references);
  if (irt) headers['In-Reply-To'] = irt;
  if (refs) headers['References'] = refs;

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

export default router;

/**
 * Inbox routes — reads real Gmail messages from all connected sending accounts.
 *
 * GET /api/inbox/accounts          → list connected Gmail account emails
 * GET /api/inbox/messages          → list messages (folder: inbox|sent|spam)
 * GET /api/inbox/thread/:threadId  → full thread with message bodies
 * POST /api/inbox/mark-read        → remove UNREAD label from a message
 */

import { Router, Request, Response } from 'express';
import { getGmailClient, createGmailClientFromCredentials } from '../services/gmail-client.js';
import { fetchSmtpThread, searchImapThreadByEmail } from '../services/imap-thread-fetcher.js';
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

  function walk(part: any) {
    if (!part) return;
    if (part.mimeType === 'text/html' && part.body?.data) {
      html = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      plain = decodeBase64Url(part.body.data);
    }
    if (part.parts) (part.parts as any[]).forEach(walk);
  }
  walk(payload);

  // Strip outer HTML document wrapper so Gmail's injected styles don't override our CSS
  if (html) html = extractBodyContent(html);
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
      .select('id, sender_email, gmail_message_id')
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

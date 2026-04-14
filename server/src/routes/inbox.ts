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
      .eq('auth_type', 'gmail_oauth')
      .not('gmail_refresh_token', 'is', null);

    for (const acc of dbAccounts ?? []) {
      if (!acc.gmail_client_id || !acc.gmail_client_secret || !acc.gmail_refresh_token) continue;
      const email = (acc.email as string).toLowerCase();
      if (clients.some(c => c.email === email)) continue;
      clients.push({
        email,
        gmail: createGmailClientFromCredentials(
          acc.gmail_client_id, acc.gmail_client_secret, acc.gmail_refresh_token
        ),
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

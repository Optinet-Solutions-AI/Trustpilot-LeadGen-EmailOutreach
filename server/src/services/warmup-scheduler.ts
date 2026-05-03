/**
 * Email warmup scheduler.
 *
 * Runs every 10 minutes and processes four types of actions:
 *
 *  1. SEND  — pick random pairs from the warmup pool, send a warmup email A→B
 *  2. OPEN  — 5–30 min after send: account B opens the email, marks important/flagged
 *  3. REPLY — 5–30 min after open: account B replies to A
 *  4. READ  — 5–30 min after reply: account A reads B's reply, marks important/flagged
 *
 * This simulates a real two-way conversation across multiple ISPs (Gmail,
 * Yahoo, Outlook, custom-domain). Each ISP sees natural send/open/reply
 * behaviour from accounts that genuinely receive and engage with mail.
 *
 * Supported account types:
 *  - Gmail OAuth (gmail_refresh_token)         — uses Gmail API
 *  - SMTP + IMAP  (smtp_*  +  imap_* creds)    — uses Nodemailer + ImapFlow
 *  - app_password (Gmail SMTP via app-pwd)     — same as gmail_oauth path
 *
 * warmup_enabled = true is required.
 * At least 2 accounts must be in the pool for pairing.
 */

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { getSupabase } from '../lib/supabase.js';
import { createGmailClientFromCredentials } from './gmail-client.js';
import { randomTemplate, generateWarmupUid, randomPhaseDelay } from './warmup-templates.js';

const SCHEDULER_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const TAG = '[Warmup]';

// ─── Account types ────────────────────────────────────────────────────────────

interface WarmupAccountBase {
  id: string;
  email: string;
  from_name: string;
  warmup_daily_target: number;
}

interface GmailWarmupAccount extends WarmupAccountBase {
  auth_type: 'gmail_oauth' | 'app_password';
  gmail_client_id: string;
  gmail_client_secret: string;
  gmail_refresh_token: string;
}

interface SmtpWarmupAccount extends WarmupAccountBase {
  auth_type: 'smtp';
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
}

type WarmupAccount = GmailWarmupAccount | SmtpWarmupAccount;

const isGmail = (a: WarmupAccount): a is GmailWarmupAccount =>
  a.auth_type === 'gmail_oauth' || a.auth_type === 'app_password';
const isSmtp  = (a: WarmupAccount): a is SmtpWarmupAccount =>
  a.auth_type === 'smtp';

// ─── Gmail helpers ────────────────────────────────────────────────────────────

type GmailClient = ReturnType<typeof createGmailClientFromCredentials>;

/** Send a plain-text email via Gmail API */
async function gmailSend(
  client: GmailClient,
  from: string,
  fromName: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string,
  replyToMessageId?: string,
): Promise<{ messageId: string; threadId: string; rfcMessageId?: string }> {
  const fromHeader = `${fromName} <${from}>`;
  const date = new Date().toUTCString();

  const lines = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `MIME-Version: 1.0`,
  ];

  if (replyToMessageId) {
    lines.push(`In-Reply-To: ${replyToMessageId}`);
    lines.push(`References: ${replyToMessageId}`);
  }

  lines.push('', body);

  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

  const res = await client.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      ...(threadId ? { threadId } : {}),
    },
  });

  return {
    messageId: res.data.id!,
    threadId:  res.data.threadId!,
  };
}

/** Find a message in a Gmail inbox by warmup UID embedded in the subject */
async function findMessageByUidGmail(
  client: GmailClient,
  warmupUid: string,
): Promise<{ id: string; threadId: string; rfcMessageId?: string } | null> {
  const res = await client.users.messages.list({
    userId: 'me',
    q: `${warmupUid}`,
    maxResults: 1,
  });

  const messages = res.data.messages;
  if (!messages || messages.length === 0) return null;

  const msg = await client.users.messages.get({
    userId: 'me',
    id: messages[0].id!,
    format: 'metadata',
    metadataHeaders: ['Message-ID'],
  });

  const rfcMessageId = msg.data.payload?.headers
    ?.find(h => h.name?.toLowerCase() === 'message-id')?.value;

  return {
    id:           messages[0].id!,
    threadId:     msg.data.threadId!,
    rfcMessageId: rfcMessageId ?? undefined,
  };
}

/** Mark a Gmail message as read + important */
async function markReadAndImportantGmail(client: GmailClient, messageId: string): Promise<void> {
  await client.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD'],
      addLabelIds:    ['IMPORTANT'],
    },
  });
}

// ─── SMTP/IMAP helpers ────────────────────────────────────────────────────────

const smtpTransporters = new Map<string, nodemailer.Transporter>();

function getSmtpTransporter(account: SmtpWarmupAccount): nodemailer.Transporter {
  const cached = smtpTransporters.get(account.smtp_user);
  if (cached) return cached;

  const secure = account.smtp_port === 465;
  const t = nodemailer.createTransport({
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    host: account.smtp_host,
    port: account.smtp_port,
    secure,
    auth: { user: account.smtp_user, pass: account.smtp_password },
  });
  smtpTransporters.set(account.smtp_user, t);
  return t;
}

/** Send a plain-text email via SMTP. Returns the RFC Message-ID we generated. */
async function smtpSend(
  account: SmtpWarmupAccount,
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string,
): Promise<{ rfcMessageId: string }> {
  const transporter = getSmtpTransporter(account);

  // Pre-generate stable Message-ID so the lookup later finds the same value.
  const hostPart = account.email.split('@')[1] || 'localhost';
  const messageId = `<${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}@${hostPart}>`;

  await transporter.sendMail({
    from: `"${account.from_name}" <${account.email}>`,
    to,
    subject,
    text: body,
    messageId,
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });

  return { rfcMessageId: messageId };
}

function imapClient(account: SmtpWarmupAccount): ImapFlow {
  return new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: { user: account.imap_user, pass: account.imap_pass },
    logger: false,
    connectionTimeout: 15000,
  });
}

/**
 * Find a message in the recipient's INBOX by searching for the warmup UID
 * embedded in the subject. Returns the IMAP UID + RFC Message-ID for threading.
 */
async function findMessageByUidImap(
  account: SmtpWarmupAccount,
  warmupUid: string,
): Promise<{ uid: number; rfcMessageId: string | null } | null> {
  const client = imapClient(account);
  let connected = false;
  try {
    await client.connect();
    connected = true;

    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ subject: `[ref:${warmupUid}]` });
      if (!uids || uids.length === 0) return null;

      const targetUid = uids[uids.length - 1]; // most recent match
      let rfcMessageId: string | null = null;

      for await (const msg of client.fetch(targetUid, { envelope: true, uid: true }, { uid: true })) {
        rfcMessageId = msg.envelope?.messageId ?? null;
      }

      return { uid: targetUid, rfcMessageId };
    } finally {
      lock.release();
    }
  } catch (err) {
    console.warn(`${TAG} IMAP search failed for ${account.email} uid ${warmupUid}:`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (connected) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }
}

/**
 * Mark an IMAP message as Seen + Flagged. \\Flagged is universal across IMAP
 * servers — \\Important is Gmail-only and unreliable on Yahoo/Outlook/Titan.
 */
async function markReadFlaggedImap(account: SmtpWarmupAccount, uid: number): Promise<void> {
  const client = imapClient(account);
  let connected = false;
  try {
    await client.connect();
    connected = true;

    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen', '\\Flagged'], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    if (connected) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }
}

// ─── Provider-agnostic dispatch ───────────────────────────────────────────────

/** Send a warmup email from `sender` → `recipient`. Returns IDs we need to track. */
async function dispatchSend(
  sender: WarmupAccount,
  recipient: WarmupAccount,
  subject: string,
  body: string,
): Promise<{ messageId: string; threadId: string | null; rfcMessageId: string | null }> {
  if (isGmail(sender)) {
    const client = createGmailClientFromCredentials(
      sender.gmail_client_id, sender.gmail_client_secret, sender.gmail_refresh_token,
    );
    const sent = await gmailSend(client, sender.email, sender.from_name, recipient.email, subject, body);
    return { messageId: sent.messageId, threadId: sent.threadId, rfcMessageId: null };
  }
  // SMTP — there's no provider-side thread ID; we just keep RFC Message-ID
  const sent = await smtpSend(sender, recipient.email, subject, body);
  return { messageId: sent.rfcMessageId, threadId: null, rfcMessageId: sent.rfcMessageId };
}

/** Find message in recipient's inbox by warmup UID. */
async function dispatchFindByUid(
  account: WarmupAccount,
  warmupUid: string,
): Promise<{ providerId: string | null; threadId: string | null; rfcMessageId: string | null } | null> {
  if (isGmail(account)) {
    const client = createGmailClientFromCredentials(
      account.gmail_client_id, account.gmail_client_secret, account.gmail_refresh_token,
    );
    const found = await findMessageByUidGmail(client, warmupUid);
    if (!found) return null;
    return { providerId: found.id, threadId: found.threadId, rfcMessageId: found.rfcMessageId ?? null };
  }
  const found = await findMessageByUidImap(account, warmupUid);
  if (!found) return null;
  return { providerId: String(found.uid), threadId: null, rfcMessageId: found.rfcMessageId };
}

/** Mark recipient's copy of the message as read + important/flagged. */
async function dispatchMarkRead(account: WarmupAccount, providerId: string): Promise<void> {
  if (isGmail(account)) {
    const client = createGmailClientFromCredentials(
      account.gmail_client_id, account.gmail_client_secret, account.gmail_refresh_token,
    );
    await markReadAndImportantGmail(client, providerId);
    return;
  }
  await markReadFlaggedImap(account, Number(providerId));
}

/** Reply to a previous message — threading via In-Reply-To/References for SMTP, threadId for Gmail. */
async function dispatchReply(
  sender: WarmupAccount,
  recipient: WarmupAccount,
  subject: string,
  body: string,
  threadId: string | null,
  replyToRfcMessageId: string | null,
): Promise<{ messageId: string }> {
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  if (isGmail(sender)) {
    const client = createGmailClientFromCredentials(
      sender.gmail_client_id, sender.gmail_client_secret, sender.gmail_refresh_token,
    );
    const sent = await gmailSend(
      client, sender.email, sender.from_name, recipient.email, replySubject, body,
      threadId ?? undefined, replyToRfcMessageId ?? undefined,
    );
    return { messageId: sent.messageId };
  }
  const sent = await smtpSend(sender, recipient.email, replySubject, body, replyToRfcMessageId ?? undefined);
  return { messageId: sent.rfcMessageId };
}

// ─── Pool ─────────────────────────────────────────────────────────────────────

async function getWarmupPool(): Promise<WarmupAccount[]> {
  const { data, error } = await getSupabase()
    .from('email_accounts')
    .select(`id, email, from_name, auth_type, warmup_daily_target,
             gmail_client_id, gmail_client_secret, gmail_refresh_token,
             smtp_host, smtp_port, smtp_user, smtp_password,
             imap_host, imap_port, imap_user, imap_pass`)
    .eq('warmup_enabled', true)
    .eq('status', 'active')
    .in('auth_type', ['gmail_oauth', 'smtp', 'app_password']);

  if (error) throw new Error(`Could not load warmup pool: ${error.message}`);

  const pool: WarmupAccount[] = [];
  for (const a of (data ?? []) as Array<Record<string, unknown>>) {
    const auth = a.auth_type as string;
    const base = {
      id:                  a.id as string,
      email:               a.email as string,
      from_name:           a.from_name as string,
      warmup_daily_target: (a.warmup_daily_target as number | null) ?? 5,
    };

    if ((auth === 'gmail_oauth' || auth === 'app_password')
        && a.gmail_client_id && a.gmail_client_secret && a.gmail_refresh_token) {
      pool.push({
        ...base,
        auth_type:           auth,
        gmail_client_id:     a.gmail_client_id as string,
        gmail_client_secret: a.gmail_client_secret as string,
        gmail_refresh_token: a.gmail_refresh_token as string,
      });
    } else if (auth === 'smtp'
        && a.smtp_host && a.smtp_user && a.smtp_password
        && a.imap_host && a.imap_user && a.imap_pass) {
      pool.push({
        ...base,
        auth_type:     'smtp',
        smtp_host:     a.smtp_host     as string,
        smtp_port:     (a.smtp_port    as number | null) ?? 587,
        smtp_user:     a.smtp_user     as string,
        smtp_password: a.smtp_password as string,
        imap_host:     a.imap_host     as string,
        imap_port:     (a.imap_port    as number | null) ?? 993,
        imap_user:     a.imap_user     as string,
        imap_pass:     a.imap_pass     as string,
      });
    }
  }
  return pool;
}

async function getWarmupSentTodayCount(email: string): Promise<number> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const { count } = await getSupabase()
    .from('warmup_emails')
    .select('id', { count: 'exact', head: true })
    .eq('from_account', email)
    .gte('sent_at', dayStart.toISOString());

  return count ?? 0;
}

// ─── Stage processors ─────────────────────────────────────────────────────────

/** Stage 1: Send new warmup emails from accounts that haven't hit their daily target */
async function processSends(pool: WarmupAccount[]): Promise<void> {
  if (pool.length < 2) {
    console.log(`${TAG} Pool has ${pool.length} account(s) — need at least 2 to warm up. Add more accounts.`);
    return;
  }

  for (const sender of pool) {
    const sentToday = await getWarmupSentTodayCount(sender.email);
    if (sentToday >= sender.warmup_daily_target) continue;

    // 1 send per 10-min tick keeps cadence natural
    const recipients = pool.filter(a => a.email !== sender.email);
    if (recipients.length === 0) continue;
    const recipient = recipients[Math.floor(Math.random() * recipients.length)];

    const template  = randomTemplate();
    const warmupUid = generateWarmupUid();

    const subject = `${template.subject} [ref:${warmupUid}]`;
    const body    = `${template.body}\n${sender.from_name}`;

    try {
      const sent = await dispatchSend(sender, recipient, subject, body);
      const processAfter = new Date(Date.now() + randomPhaseDelay());

      await getSupabase().from('warmup_emails').insert({
        from_account:     sender.email,
        to_account:       recipient.email,
        subject,
        body,
        warmup_uid:       warmupUid,
        gmail_message_id: sent.rfcMessageId ?? sent.messageId,
        gmail_thread_id:  sent.threadId,
        reply_body:       `${template.replyBody}\n${recipient.from_name}`,
        stage:            'pending_open',
        process_after:    processAfter.toISOString(),
      });

      console.log(`${TAG} Sent: ${sender.email} → ${recipient.email} (uid: ${warmupUid}, ${sender.auth_type})`);
    } catch (err) {
      console.warn(`${TAG} Send failed ${sender.email} → ${recipient.email}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Stage 2: Recipient opens emails that are ready (process_after has passed) */
async function processOpens(pool: WarmupAccount[]): Promise<void> {
  const poolIndex = new Map(pool.map(a => [a.email, a]));

  const { data: pending } = await getSupabase()
    .from('warmup_emails')
    .select('id, to_account, warmup_uid, gmail_thread_id')
    .eq('stage', 'pending_open')
    .lte('process_after', new Date().toISOString())
    .limit(20);

  for (const row of pending ?? []) {
    const recipient = poolIndex.get(row.to_account);
    if (!recipient) {
      await getSupabase().from('warmup_emails').update({ stage: 'failed' }).eq('id', row.id);
      continue;
    }

    try {
      const found = await dispatchFindByUid(recipient, row.warmup_uid);
      if (!found) {
        // Not delivered yet — push process_after forward and retry later
        const retry = new Date(Date.now() + 5 * 60 * 1000);
        await getSupabase().from('warmup_emails').update({ process_after: retry.toISOString() }).eq('id', row.id);
        console.log(`${TAG} Open: message not found yet for uid ${row.warmup_uid}, will retry`);
        continue;
      }

      if (found.providerId) await dispatchMarkRead(recipient, found.providerId);

      const processAfter = new Date(Date.now() + randomPhaseDelay());
      await getSupabase().from('warmup_emails').update({
        stage:            'pending_reply',
        opened_at:        new Date().toISOString(),
        process_after:    processAfter.toISOString(),
        gmail_message_id: found.rfcMessageId ?? found.providerId ?? null,
        gmail_thread_id:  found.threadId,
      }).eq('id', row.id);

      console.log(`${TAG} Opened: ${row.to_account} read message uid ${row.warmup_uid}`);
    } catch (err) {
      console.warn(`${TAG} Open failed uid ${row.warmup_uid}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Stage 3: Recipient replies to the warmup email */
async function processReplies(pool: WarmupAccount[]): Promise<void> {
  const poolIndex = new Map(pool.map(a => [a.email, a]));

  const { data: pending } = await getSupabase()
    .from('warmup_emails')
    .select('id, from_account, to_account, subject, reply_body, gmail_message_id, gmail_thread_id')
    .eq('stage', 'pending_reply')
    .lte('process_after', new Date().toISOString())
    .limit(20);

  for (const row of pending ?? []) {
    const recipient = poolIndex.get(row.to_account);
    const sender    = poolIndex.get(row.from_account);
    if (!recipient || !sender) {
      await getSupabase().from('warmup_emails').update({ stage: 'failed' }).eq('id', row.id);
      continue;
    }

    try {
      const reply = await dispatchReply(
        recipient, sender,
        row.subject, row.reply_body,
        row.gmail_thread_id ?? null,
        row.gmail_message_id ?? null,
      );

      const processAfter = new Date(Date.now() + randomPhaseDelay());
      await getSupabase().from('warmup_emails').update({
        stage:            'pending_read',
        replied_at:       new Date().toISOString(),
        process_after:    processAfter.toISOString(),
        gmail_message_id: reply.messageId,  // now points to reply so A can find it
      }).eq('id', row.id);

      console.log(`${TAG} Replied: ${row.to_account} → ${row.from_account}`);
    } catch (err) {
      console.warn(`${TAG} Reply failed for ${row.to_account}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Stage 4: Original sender reads the reply */
async function processReadReplies(pool: WarmupAccount[]): Promise<void> {
  const poolIndex = new Map(pool.map(a => [a.email, a]));

  const { data: pending } = await getSupabase()
    .from('warmup_emails')
    .select('id, from_account, to_account, warmup_uid, gmail_thread_id')
    .eq('stage', 'pending_read')
    .lte('process_after', new Date().toISOString())
    .limit(20);

  for (const row of pending ?? []) {
    const sender = poolIndex.get(row.from_account);
    if (!sender) {
      await getSupabase().from('warmup_emails').update({ stage: 'failed' }).eq('id', row.id);
      continue;
    }

    try {
      const found = await dispatchFindByUid(sender, row.warmup_uid);
      if (!found) {
        const retry = new Date(Date.now() + 5 * 60 * 1000);
        await getSupabase().from('warmup_emails').update({ process_after: retry.toISOString() }).eq('id', row.id);
        continue;
      }

      if (found.providerId) await dispatchMarkRead(sender, found.providerId);

      await getSupabase().from('warmup_emails').update({
        stage:          'complete',
        reply_read_at:  new Date().toISOString(),
        process_after:  new Date().toISOString(),
      }).eq('id', row.id);

      console.log(`${TAG} Complete: full cycle done for uid ${row.warmup_uid}`);
    } catch (err) {
      console.warn(`${TAG} Read-reply failed uid ${row.warmup_uid}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Run one full warmup tick (called every 10 min by startWarmupScheduler) */
export async function runWarmupTick(): Promise<void> {
  let pool: WarmupAccount[];
  try {
    pool = await getWarmupPool();
  } catch (err) {
    console.warn(`${TAG} Could not load pool:`, err instanceof Error ? err.message : err);
    return;
  }

  if (pool.length === 0) return;

  await Promise.allSettled([
    processSends(pool),
    processOpens(pool),
    processReplies(pool),
    processReadReplies(pool),
  ]);
}

/** Start the background warmup scheduler */
export function startWarmupScheduler(): void {
  console.log(`${TAG} Scheduler started (interval: ${SCHEDULER_INTERVAL_MS / 60_000} min)`);

  runWarmupTick().catch(err =>
    console.error(`${TAG} Initial tick error:`, err instanceof Error ? err.message : err)
  );

  setInterval(() => {
    runWarmupTick().catch(err =>
      console.error(`${TAG} Tick error:`, err instanceof Error ? err.message : err)
    );
  }, SCHEDULER_INTERVAL_MS);
}

/** Get warmup stats for all accounts in the pool */
export async function getWarmupStats(): Promise<Record<string, {
  sentToday: number;
  totalSent: number;
  totalCompleted: number;
  lastSentAt: string | null;
}>> {
  const supabase = getSupabase();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const { data: rows } = await supabase
    .from('warmup_emails')
    .select('from_account, stage, sent_at')
    .order('sent_at', { ascending: false });

  const stats: Record<string, { sentToday: number; totalSent: number; totalCompleted: number; lastSentAt: string | null }> = {};

  for (const row of rows ?? []) {
    if (!stats[row.from_account]) {
      stats[row.from_account] = { sentToday: 0, totalSent: 0, totalCompleted: 0, lastSentAt: null };
    }
    const s = stats[row.from_account];
    s.totalSent++;
    if (row.stage === 'complete') s.totalCompleted++;
    if (new Date(row.sent_at) >= dayStart) s.sentToday++;
    if (!s.lastSentAt) s.lastSentAt = row.sent_at;
  }

  return stats;
}

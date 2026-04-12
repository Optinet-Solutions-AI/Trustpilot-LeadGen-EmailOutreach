/**
 * Email warmup scheduler.
 *
 * Runs every 10 minutes and processes three types of actions:
 *
 *  1. SEND  — pick random pairs from the warmup pool, send a warmup email A→B
 *  2. OPEN  — 5–30 min after send: account B opens the email, marks important
 *  3. REPLY — 5–30 min after open: account B replies to A
 *  4. READ  — 5–30 min after reply: account A reads B's reply, marks important
 *
 * This simulates a real two-way conversation. Google sees natural send/open/reply
 * behaviour from multiple accounts, which builds sender reputation.
 *
 * Requirements:
 *  - Accounts must have auth_type = 'gmail_oauth' with stored credentials
 *  - warmup_enabled = true on the account
 *  - At least 2 accounts in the pool for pairing
 */

import { getSupabase } from '../lib/supabase.js';
import { createGmailClientFromCredentials } from './gmail-client.js';
import { randomTemplate, generateWarmupUid, randomPhaseDelay } from './warmup-templates.js';

const SCHEDULER_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const TAG = '[Warmup]';

interface WarmupAccount {
  id: string;
  email: string;
  from_name: string;
  gmail_client_id: string;
  gmail_client_secret: string;
  gmail_refresh_token: string;
  warmup_daily_target: number;
}

// ─── Gmail helpers ────────────────────────────────────────────────────────────

type GmailClient = ReturnType<typeof createGmailClientFromCredentials>;

/** Send a plain-text email and return { messageId, threadId } */
async function gmailSend(
  client: GmailClient,
  from: string,
  fromName: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string,
  replyToMessageId?: string,
): Promise<{ messageId: string; threadId: string }> {
  const fromHeader = `${fromName} <${from}>`;
  const date = new Date().toUTCString();

  // Build RFC 2822 message
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

/** Find a message in an inbox by searching for the warmup UID */
async function findMessageByUid(
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

/** Mark a message as read and important */
async function markReadAndImportant(client: GmailClient, messageId: string): Promise<void> {
  await client.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD'],
      addLabelIds:    ['IMPORTANT'],
    },
  });
}

// ─── Pool helpers ─────────────────────────────────────────────────────────────

async function getWarmupPool(): Promise<WarmupAccount[]> {
  const { data, error } = await getSupabase()
    .from('email_accounts')
    .select('id, email, from_name, gmail_client_id, gmail_client_secret, gmail_refresh_token, warmup_daily_target')
    .eq('warmup_enabled', true)
    .eq('status', 'active')
    .eq('auth_type', 'gmail_oauth')
    .not('gmail_refresh_token', 'is', null);

  if (error) throw new Error(`Could not load warmup pool: ${error.message}`);
  return (data ?? []).filter(
    a => a.gmail_client_id && a.gmail_client_secret && a.gmail_refresh_token
  ) as WarmupAccount[];
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

    // How many can we send this tick? Send 1 per 10-min tick to stay natural
    const toSend = 1;

    for (let i = 0; i < toSend; i++) {
      // Pick a random recipient that is NOT the sender
      const recipients = pool.filter(a => a.email !== sender.email);
      if (recipients.length === 0) break;
      const recipient = recipients[Math.floor(Math.random() * recipients.length)];

      const template  = randomTemplate();
      const warmupUid = generateWarmupUid();

      // Embed the warmup UID in the subject so we can find it in the recipient's inbox
      const subject = `${template.subject} [ref:${warmupUid}]`;
      // Build the body with sender name
      const body = `${template.body}\n${sender.from_name}`;

      const senderClient = createGmailClientFromCredentials(
        sender.gmail_client_id, sender.gmail_client_secret, sender.gmail_refresh_token,
      );

      try {
        const { messageId, threadId } = await gmailSend(
          senderClient,
          sender.email,
          sender.from_name,
          recipient.email,
          subject,
          body,
        );

        // Schedule next stage: recipient opens the email in 5–30 min
        const processAfter = new Date(Date.now() + randomPhaseDelay());

        await getSupabase().from('warmup_emails').insert({
          from_account:     sender.email,
          to_account:       recipient.email,
          subject,
          body,
          warmup_uid:       warmupUid,
          gmail_message_id: messageId,
          gmail_thread_id:  threadId,
          reply_body:       `${template.replyBody}\n${recipient.from_name}`,
          stage:            'pending_open',
          process_after:    processAfter.toISOString(),
        });

        console.log(`${TAG} Sent: ${sender.email} → ${recipient.email} (uid: ${warmupUid})`);
      } catch (err) {
        console.warn(`${TAG} Send failed ${sender.email} → ${recipient.email}:`, err instanceof Error ? err.message : err);
      }
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
      // Account removed from pool — mark failed
      await getSupabase().from('warmup_emails').update({ stage: 'failed' }).eq('id', row.id);
      continue;
    }

    const recipientClient = createGmailClientFromCredentials(
      recipient.gmail_client_id, recipient.gmail_client_secret, recipient.gmail_refresh_token,
    );

    try {
      // Find the message in recipient's inbox by warmup UID
      const found = await findMessageByUid(recipientClient, row.warmup_uid);
      if (!found) {
        // Not delivered yet — push process_after forward and retry later
        const retry = new Date(Date.now() + 5 * 60 * 1000);
        await getSupabase().from('warmup_emails').update({ process_after: retry.toISOString() }).eq('id', row.id);
        console.log(`${TAG} Open: message not found yet for uid ${row.warmup_uid}, will retry`);
        continue;
      }

      await markReadAndImportant(recipientClient, found.id);

      const processAfter = new Date(Date.now() + randomPhaseDelay());
      await getSupabase().from('warmup_emails').update({
        stage:         'pending_reply',
        opened_at:     new Date().toISOString(),
        process_after: processAfter.toISOString(),
        // Store RFC message ID for proper threading in the reply
        gmail_message_id: found.rfcMessageId ?? found.id,
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

    const recipientClient = createGmailClientFromCredentials(
      recipient.gmail_client_id, recipient.gmail_client_secret, recipient.gmail_refresh_token,
    );

    try {
      const replySubject = row.subject.startsWith('Re:') ? row.subject : `Re: ${row.subject}`;
      const { messageId: replyMsgId } = await gmailSend(
        recipientClient,
        recipient.email,
        recipient.from_name,
        sender.email,
        replySubject,
        row.reply_body,
        row.gmail_thread_id,
        row.gmail_message_id,
      );

      const processAfter = new Date(Date.now() + randomPhaseDelay());
      await getSupabase().from('warmup_emails').update({
        stage:            'pending_read',
        replied_at:       new Date().toISOString(),
        process_after:    processAfter.toISOString(),
        gmail_message_id: replyMsgId,  // now points to reply so A can find it
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

    const senderClient = createGmailClientFromCredentials(
      sender.gmail_client_id, sender.gmail_client_secret, sender.gmail_refresh_token,
    );

    try {
      // Find the reply in sender's inbox — search by warmup UID in the thread
      const found = await findMessageByUid(senderClient, row.warmup_uid);
      if (!found) {
        const retry = new Date(Date.now() + 5 * 60 * 1000);
        await getSupabase().from('warmup_emails').update({ process_after: retry.toISOString() }).eq('id', row.id);
        continue;
      }

      await markReadAndImportant(senderClient, found.id);

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

  if (pool.length === 0) return; // nothing to do

  // Process all stages in parallel — they operate on different rows
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

  // Run immediately on start to catch any pending actions after a restart
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

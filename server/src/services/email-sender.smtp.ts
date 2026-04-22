/**
 * Nodemailer SMTP email sender.
 * Used for DreamHost, Bluehost Titan, and other custom SMTP providers.
 * Port 465 → SSL, port 587 → STARTTLS.
 *
 * After a successful SMTP send, the raw MIME message is also IMAP-APPENDED
 * to the account's Sent folder so webmail and native email clients see a
 * copy of every outreach email (same behaviour as Gmail/Outlook clients).
 */

import fs from 'fs';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { SendEmailOptions, SendEmailResult } from './email-sender.gmail.js';

export interface SmtpSenderAccount {
  email: string;
  fromName: string;
  auth_type: 'smtp';
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  // Optional IMAP creds — when present, sent messages are appended to the Sent folder
  imap_host?: string | null;
  imap_port?: number | null;
  imap_user?: string | null;
  imap_pass?: string | null;
}

async function fetchScreenshot(screenshotPath: string): Promise<Buffer | null> {
  if (!screenshotPath) return null;
  if (screenshotPath.startsWith('http')) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(screenshotPath);
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        console.warn(`[SMTP] Screenshot fetch attempt ${attempt} failed: HTTP ${res.status}`);
      } catch (e) {
        console.warn(`[SMTP] Screenshot fetch attempt ${attempt} error:`, e instanceof Error ? e.message : e);
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
    }
    return null;
  }
  if (fs.existsSync(screenshotPath)) return fs.readFileSync(screenshotPath);
  return null;
}

// Persistent pooled transporters keyed by SMTP user — avoids a new TLS handshake per send.
const transporterCache = new Map<string, nodemailer.Transporter>();

function getTransporter(account: SmtpSenderAccount): nodemailer.Transporter {
  const cached = transporterCache.get(account.smtp_user);
  if (cached) return cached;

  const secure = account.smtp_port === 465;
  const transporter = nodemailer.createTransport({
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    host: account.smtp_host,
    port: account.smtp_port,
    secure,
    auth: {
      user: account.smtp_user,
      pass: account.smtp_password,
    },
  });
  transporterCache.set(account.smtp_user, transporter);
  return transporter;
}

export async function sendEmailSmtp(
  to: string,
  subject: string,
  html: string,
  options: SendEmailOptions = {},
  account: SmtpSenderAccount,
): Promise<SendEmailResult> {
  const transporter = getTransporter(account);

  // Embed screenshot as CID inline attachment if provided
  let bodyHtml = html;
  const attachments: Array<{ filename: string; content: Buffer; contentType: string; cid: string; contentDisposition: 'inline' }> = [];

  if (options.screenshotPath) {
    const screenshotBuffer = await fetchScreenshot(options.screenshotPath);
    if (screenshotBuffer) {
      attachments.push({
        filename: 'trustpilot-profile.png',
        content: screenshotBuffer,
        contentType: 'image/png',
        cid: 'trustpilot-screenshot',
        contentDisposition: 'inline',
      });
      bodyHtml = `${bodyHtml}\n<br/><img src="cid:trustpilot-screenshot" alt="Your Trustpilot Profile" style="width:100%;max-width:550px;height:auto;border:1px solid #e2e8f0;border-radius:8px;display:block;margin-top:12px;" />`;
    } else {
      console.warn('[SMTP] Screenshot not embedded — fetch returned null');
    }
  }

  // Pre-generate a stable Message-ID so the outgoing copy AND the IMAP APPEND
  // end up with the exact same header. Without this, Nodemailer and MailComposer
  // each invent their own IDs — the DB stores one, the Sent folder gets another,
  // and inbox thread-lookup by Message-ID can never correlate them.
  const hostPart = account.email.split('@')[1] || 'localhost';
  const messageId = `<${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}@${hostPart}>`;

  const mailOptions: nodemailer.SendMailOptions = {
    from: `"${account.fromName}" <${account.email}>`,
    to,
    subject,
    html: bodyHtml,
    attachments,
    messageId,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[SMTP] Sent to ${to} via ${account.smtp_host}: ${info.messageId}`);

    // Append to IMAP Sent folder so webmail + native clients see the sent copy.
    // Fire-and-forget — a failure here must not turn a successful send into a failure.
    if (account.imap_host && account.imap_user && account.imap_pass) {
      appendToSentFolder(account, mailOptions).catch((err) => {
        console.warn(`[SMTP→IMAP] Could not append to Sent for ${account.email}:`, err instanceof Error ? err.message : err);
      });
    }

    // Return the pre-generated Message-ID rather than info.messageId — the two
    // should be identical, but being explicit guarantees the DB stores what was
    // actually sent (and what the IMAP APPEND wrote).
    return { success: true, messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SMTP] Failed to send to ${to}:`, msg);
    return { success: false, error: msg };
  }
}

async function buildRawMessage(mailOptions: nodemailer.SendMailOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, msg) => {
      if (err) reject(err);
      else resolve(msg);
    });
  });
}

async function appendToSentFolder(account: SmtpSenderAccount, mailOptions: nodemailer.SendMailOptions): Promise<void> {
  const raw = await buildRawMessage(mailOptions);
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: account.imap_host as string,
    port: account.imap_port ?? 993,
    secure: true,
    auth: { user: account.imap_user as string, pass: account.imap_pass as string },
    logger: false,
    connectionTimeout: 10000,
  });

  try {
    await client.connect();

    // Find the Sent folder — try SPECIAL-USE flag first, then common name patterns
    const mailboxes = await client.list();
    const sentBox =
      mailboxes.find((b) => b.specialUse === '\\Sent') ??
      mailboxes.find((b) => /^sent$/i.test(b.name)) ??
      mailboxes.find((b) => /^sent.messages$/i.test(b.name)) ??
      mailboxes.find((b) => /^sent.items$/i.test(b.name)) ??
      mailboxes.find((b) => /sent/i.test(b.name));

    if (!sentBox) {
      console.warn(`[SMTP→IMAP] No Sent folder found on ${account.imap_host} for ${account.email}`);
      return;
    }

    await client.append(sentBox.path, raw, ['\\Seen']);
    console.log(`[SMTP→IMAP] Appended to ${sentBox.path} for ${account.email}`);
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

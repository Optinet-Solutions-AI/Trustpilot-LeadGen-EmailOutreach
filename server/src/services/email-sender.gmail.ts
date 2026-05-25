/**
 * Gmail API email sender.
 * Uses nodemailer MailComposer for MIME construction, Gmail API for delivery.
 * Builds multipart/alternative (HTML + plain text) with deliverability headers.
 * Activated when EMAIL_MODE=gmail in .env
 */

import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import crypto from 'crypto';
import { getGmailClient } from './gmail-client.js';
import { config } from '../config.js';
import fs from 'fs';

/** An active Gmail account that can be used for sending. */
export interface GmailSenderAccount {
  email: string;
  fromName: string;
  gmail: ReturnType<typeof import('./gmail-client.js').getGmailClient>;
}

/**
 * Ensures the body string is proper HTML.
 * If the string contains no block-level HTML tags, it converts double
 * newlines to <p> paragraphs and single newlines to <br> so the email
 * doesn't arrive as one clumped block of text.
 */
function ensureHtml(body: string): string {
  if (/<p[\s>]|<br[\s/>]|<div[\s>]|<table[\s>]/i.test(body)) return body;
  return body
    .split(/\n{2,}/)
    .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * Fetch a URL and return its contents as a Buffer.
 * Retries up to `maxRetries` additional times on failure.
 */
async function fetchWithRetry(url: string, maxRetries = 2): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      console.warn(`[Gmail] Screenshot fetch attempt ${attempt} failed: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`[Gmail] Screenshot fetch attempt ${attempt} error:`, err instanceof Error ? err.message : err);
    }
    if (attempt <= maxRetries) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

/**
 * Strips HTML to plain text for the multipart/alternative text part.
 * Handles common patterns used in email templates.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SendEmailOptions {
  screenshotPath?: string;
  /** RFC 2822 In-Reply-To. Pass the previous send's RFC822 Message-ID
   *  (with or without angle brackets) so the recipient's mail client groups
   *  this send into the existing conversation instead of starting a new one. */
  inReplyTo?: string;
  /** RFC 2822 References — full breadcrumb trail of Message-IDs in the
   *  conversation, space-separated, angle-bracketed. Falls back to the
   *  inReplyTo value when omitted. */
  references?: string;
  /** Gmail-only: thread the new message into a specific Gmail thread by ID.
   *  When provided, the Gmail API will graft the message onto that thread
   *  even if RFC822 headers wouldn't normally cluster it there. Ignored by
   *  the SMTP sender (no equivalent concept). */
  gmailThreadId?: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  options: SendEmailOptions = {},
  account?: GmailSenderAccount,
): Promise<SendEmailResult> {
  try {
    const gmail = account?.gmail ?? getGmailClient();
    const fromEmail = account?.email ?? config.gmail.fromEmail;
    const fromName  = account?.fromName ?? config.gmail.fromName;

    const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

    // Build attachments array for inline CID screenshot
    const attachments: Array<{
      filename: string;
      content: Buffer;
      contentType: string;
      cid: string;
      contentDisposition: 'inline';
    }> = [];

    let bodyHtml = ensureHtml(html);

    if (options.screenshotPath) {
      let screenshotBuffer: Buffer | null = null;

      if (options.screenshotPath.startsWith('http')) {
        // Fetch from URL (Supabase Storage or Thum.io) with retry
        screenshotBuffer = await fetchWithRetry(options.screenshotPath);
        if (!screenshotBuffer) {
          console.warn('[Gmail] Screenshot fetch failed after retries — sending without image');
        }
      } else if (fs.existsSync(options.screenshotPath)) {
        screenshotBuffer = fs.readFileSync(options.screenshotPath);
      }

      if (screenshotBuffer) {
        attachments.push({
          filename: 'trustpilot-profile.png',
          content: screenshotBuffer,
          contentType: 'image/png',
          cid: 'trustpilot-screenshot',
          contentDisposition: 'inline',
        });
        bodyHtml = `${bodyHtml}\n<br/><img src="cid:trustpilot-screenshot" alt="Your Trustpilot Profile" style="width:100%;max-width:550px;height:auto;border:1px solid #e2e8f0;border-radius:8px;display:block;margin-top:12px;" />`;
      }
    }

    // Domain-aligned Message-ID improves DKIM/SPF authentication
    const senderDomain = fromEmail.split('@')[1] || 'gmail.com';

    // Threading headers — wrap each ID in angle brackets if the caller didn't.
    // References falls back to inReplyTo so a single-ID parent still ends up
    // in the chain (some MUAs reject References-less conversations even when
    // In-Reply-To is present).
    const headers: Record<string, string> = {
      'List-Unsubscribe': `<mailto:${fromEmail}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
    const wrapAngles = (id: string): string => {
      const trimmed = id.trim().replace(/^<|>$/g, '');
      return trimmed ? `<${trimmed}>` : '';
    };
    if (options.inReplyTo) {
      const irt = wrapAngles(options.inReplyTo);
      if (irt) headers['In-Reply-To'] = irt;
    }
    if (options.references || options.inReplyTo) {
      // References can be a pre-built "<A> <B>" chain — pass through verbatim
      // when it already contains angle brackets; otherwise wrap a bare ID.
      const refsRaw = options.references ?? options.inReplyTo ?? '';
      const refs = /<[^>]+>/.test(refsRaw) ? refsRaw : wrapAngles(refsRaw);
      if (refs) headers['References'] = refs;
    }

    const mailOptions: Record<string, unknown> = {
      from,
      to,
      subject,
      html: bodyHtml,
      text: htmlToPlainText(bodyHtml),
      attachments,
      messageId: `<${crypto.randomUUID()}@${senderDomain}>`,
      headers,
    };

    // Build raw MIME message with nodemailer MailComposer
    const raw = await new Promise<string>((resolve, reject) => {
      const mail = new MailComposer(mailOptions);
      mail.compile().build((err, message) => {
        if (err) return reject(err);
        // Convert to base64url (Gmail API requirement)
        const encoded = message
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        resolve(encoded);
      });
    });

    const requestBody: Record<string, unknown> = { raw };
    // Gmail's own threading: pass threadId explicitly so the send is grafted
    // onto the existing conversation in the user's mailbox view, regardless
    // of how the recipient's MUA interprets the RFC822 headers.
    if (options.gmailThreadId) requestBody.threadId = options.gmailThreadId;

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody,
    });

    return {
      success: true,
      messageId: response.data.id ?? undefined,
      threadId: response.data.threadId ?? undefined,
    };
  } catch (err: unknown) {
    const error = err as { code?: number; message?: string };
    if (error.code === 401) {
      console.error('[Gmail] Authentication error — check your OAuth credentials and refresh token');
    }
    return {
      success: false,
      error: error.message || String(err),
    };
  }
}

export async function sendCampaignEmails(
  _campaignId: string,
  emails: Array<{ campaignLeadId: string; to: string; subject: string; html: string }>
): Promise<{ sent: number; failed: number }> {
  // This synchronous version is kept for backward compat.
  // In practice, campaign sends go through campaign-sender.ts (async with delays).
  let sent = 0;
  let failed = 0;
  for (const email of emails) {
    const result = await sendEmail(email.to, email.subject, email.html);
    if (result.success) sent++;
    else failed++;
  }
  return { sent, failed };
}

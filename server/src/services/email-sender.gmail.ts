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
  options: SendEmailOptions = {}
): Promise<SendEmailResult> {
  try {
    const gmail = getGmailClient();

    const from = config.gmail.fromName
      ? `"${config.gmail.fromName}" <${config.gmail.fromEmail}>`
      : config.gmail.fromEmail;

    // Build attachments array for inline CID screenshot
    const attachments: Array<{
      filename: string;
      content: Buffer;
      contentType: string;
      cid: string;
      contentDisposition: 'inline';
    }> = [];

    let bodyHtml = html;

    if (options.screenshotPath) {
      let screenshotBuffer: Buffer | null = null;

      if (options.screenshotPath.startsWith('http')) {
        // Fetch from Supabase Storage URL
        try {
          const res = await fetch(options.screenshotPath);
          if (res.ok) screenshotBuffer = Buffer.from(await res.arrayBuffer());
        } catch (err) {
          console.warn('[Gmail] Failed to fetch screenshot from URL:', err);
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
        bodyHtml = `${html}\n<br/><img src="cid:trustpilot-screenshot" alt="Your Trustpilot Profile" style="max-width:600px;border:1px solid #e5e7eb;border-radius:8px;" />`;
      }
    }

    // Domain-aligned Message-ID improves DKIM/SPF authentication
    const senderDomain = config.gmail.fromEmail.split('@')[1] || 'gmail.com';

    const mailOptions: Record<string, unknown> = {
      from,
      to,
      subject,
      html: bodyHtml,
      text: htmlToPlainText(bodyHtml),
      attachments,
      messageId: `<${crypto.randomUUID()}@${senderDomain}>`,
      headers: {
        'List-Unsubscribe': `<mailto:${config.gmail.fromEmail}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
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

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
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

/**
 * Gmail API email sender.
 * Uses nodemailer MailComposer for MIME construction, Gmail API for delivery.
 * Activated when EMAIL_MODE=gmail in .env
 */

import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { getGmailClient } from './gmail-client.js';
import { config } from '../config.js';
import fs from 'fs';

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

    // Build attachments array if screenshot is available
    const attachments: Array<{
      filename: string;
      content: Buffer;
      contentType: string;
      cid: string;
    }> = [];

    let bodyHtml = html;

    if (options.screenshotPath && fs.existsSync(options.screenshotPath)) {
      const screenshotBuffer = fs.readFileSync(options.screenshotPath);
      attachments.push({
        filename: 'trustpilot-profile.png',
        content: screenshotBuffer,
        contentType: 'image/png',
        cid: 'trustpilot-screenshot',
      });
      // Append inline image reference to HTML body
      bodyHtml = `${html}\n<br/><img src="cid:trustpilot-screenshot" alt="Your Trustpilot Profile" style="max-width:600px;border:1px solid #e5e7eb;border-radius:8px;" />`;
    }

    const mailOptions: Record<string, unknown> = {
      from,
      to,
      subject,
      html: bodyHtml,
      attachments,
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

/**
 * Brevo (formerly Sendinblue) transactional email sender.
 * Uses Brevo's REST API v3 — no SDK needed, just a fetch + API key.
 * Activated when EMAIL_MODE=brevo in .env
 *
 * Setup:
 *   1. Create account at brevo.com (free — 300 emails/day)
 *   2. Settings → Senders & IP → Domains → Add & verify optiratesolutions.com
 *      (Brevo walks you through DNS step by step with copy buttons)
 *   3. Settings → API Keys → Generate API key
 *   4. Set BREVO_API_KEY=your-key and EMAIL_FROM=jordi@optiratesolutions.com
 */

import { config } from '../config.js';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

// ── Helpers ────────────────────────────────────────────────────────────────

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SendEmailOptions {
  screenshotPath?: string; // ignored for Brevo (screenshot embedded in HTML via URL)
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ── Single email send ──────────────────────────────────────────────────────

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  _options: SendEmailOptions = {}
): Promise<SendEmailResult> {
  const apiKey = config.brevo.apiKey;
  if (!apiKey) {
    return { success: false, error: 'BREVO_API_KEY is not set. Add it to your Cloud Run env vars.' };
  }

  const fromEmail = config.gmail.fromEmail || config.brevo.fromEmail;
  const fromName  = config.gmail.fromName  || 'OptiRate';

  const payload = {
    sender:      { name: fromName, email: fromEmail },
    to:          [{ email: to }],
    subject,
    htmlContent: html,
    textContent: htmlToPlainText(html),
    headers: {
      'List-Unsubscribe': `<mailto:${fromEmail}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };

  try {
    const res = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const msg = `Brevo API ${res.status}: ${text}`;
      console.error(`[Brevo] Send failed to ${to}: ${msg}`);
      return { success: false, error: msg };
    }

    const data = await res.json() as { messageId?: string };
    console.log(`[Brevo] Sent to ${to} — messageId: ${data.messageId}`);
    return { success: true, messageId: data.messageId };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Brevo] Network error sending to ${to}: ${msg}`);
    return { success: false, error: msg };
  }
}

// ── Campaign batch send (used by campaign-sender.ts) ──────────────────────

export async function sendCampaignEmails(
  _campaignId: string,
  emails: Array<{ campaignLeadId: string; to: string; subject: string; html: string }>
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (const email of emails) {
    const result = await sendEmail(email.to, email.subject, email.html);
    if (result.success) {
      sent++;
    } else {
      failed++;
      console.warn(`[Brevo] Failed to send to ${email.to}: ${result.error}`);
    }
  }

  return { sent, failed };
}

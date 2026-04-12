/**
 * Email sender facade.
 * Routes to mock, Gmail, or Brevo sender based on EMAIL_MODE env var.
 *   EMAIL_MODE=mock   → console logs only, no real sends
 *   EMAIL_MODE=gmail  → Gmail API via OAuth2
 *   EMAIL_MODE=brevo  → Brevo transactional API (recommended)
 *
 * NOTE: test-mode transform is applied upstream in campaign-sender.ts — do NOT re-apply here.
 */

import { config } from '../config.js';
import type { GmailSenderAccount, SendEmailOptions, SendEmailResult } from './email-sender.gmail.js';

export type { GmailSenderAccount };

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  options: SendEmailOptions = {},
  account?: GmailSenderAccount,
): Promise<SendEmailResult> {
  if (config.emailMode === 'gmail') {
    const { sendEmail: sendGmail } = await import('./email-sender.gmail.js');
    return sendGmail(to, subject, html, options, account);
  }

  if (config.emailMode === 'brevo') {
    const { sendEmail: sendBrevo } = await import('./email-sender.brevo.js');
    return sendBrevo(to, subject, html, options);
  }

  // Mock mode — logs to console, never hits any email API
  const { sendEmail: sendMock } = await import('./email-sender.mock.js');
  const success = await sendMock(to, subject, html);
  return { success };
}

export async function sendCampaignEmails(
  campaignId: string,
  emails: Array<{ campaignLeadId: string; to: string; subject: string; html: string }>
): Promise<{ sent: number; failed: number }> {
  if (config.emailMode === 'gmail') {
    const { sendCampaignEmails: sendGmail } = await import('./email-sender.gmail.js');
    return sendGmail(campaignId, emails);
  }

  if (config.emailMode === 'brevo') {
    const { sendCampaignEmails: sendBrevo } = await import('./email-sender.brevo.js');
    return sendBrevo(campaignId, emails);
  }

  const { sendCampaignEmails: sendMock } = await import('./email-sender.mock.js');
  return sendMock(campaignId, emails);
}

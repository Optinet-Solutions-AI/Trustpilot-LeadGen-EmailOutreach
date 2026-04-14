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
import type { SmtpSenderAccount } from './email-sender.smtp.js';

export type { GmailSenderAccount, SmtpSenderAccount };
export type SenderAccount = GmailSenderAccount | SmtpSenderAccount;

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  options: SendEmailOptions = {},
  account?: SenderAccount,
): Promise<SendEmailResult> {
  // Route to SMTP sender when the account's auth_type is 'smtp'
  if (account && 'auth_type' in account && account.auth_type === 'smtp') {
    const { sendEmailSmtp } = await import('./email-sender.smtp.js');
    return sendEmailSmtp(to, subject, html, options, account);
  }

  if (config.emailMode === 'gmail') {
    const { sendEmail: sendGmail } = await import('./email-sender.gmail.js');
    return sendGmail(to, subject, html, options, account as GmailSenderAccount | undefined);
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

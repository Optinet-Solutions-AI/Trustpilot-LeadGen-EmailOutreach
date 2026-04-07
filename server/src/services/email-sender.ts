/**
 * Email sender facade.
 * Routes to mock or Gmail sender based on EMAIL_MODE env var.
 * NOTE: test-mode transform is applied upstream in campaign-sender.ts — do NOT re-apply here.
 */

import { config } from '../config.js';
import type { SendEmailOptions, SendEmailResult } from './email-sender.gmail.js';

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  options: SendEmailOptions = {}
): Promise<SendEmailResult> {
  if (config.emailMode === 'gmail') {
    const { sendEmail: sendGmail } = await import('./email-sender.gmail.js');
    return sendGmail(to, subject, html, options);
  }

  // Mock mode
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
  const { sendCampaignEmails: sendMock } = await import('./email-sender.mock.js');
  return sendMock(campaignId, emails);
}

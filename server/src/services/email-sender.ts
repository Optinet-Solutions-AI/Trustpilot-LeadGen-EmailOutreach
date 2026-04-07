/**
 * Email sender facade.
 * Routes to mock or Gmail sender based on EMAIL_MODE env var.
 * All calls pass through the test-mode interceptor.
 */

import { config } from '../config.js';
import { applyTestMode } from './test-mode.js';
import type { SendEmailOptions, SendEmailResult } from './email-sender.gmail.js';

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  options: SendEmailOptions & { testMode?: boolean } = {}
): Promise<SendEmailResult> {
  const { testMode: testModeOverride, ...sendOptions } = options;

  // Apply test mode transform before sending
  const transformed = applyTestMode({ to, subject, html }, testModeOverride);

  if (config.emailMode === 'gmail') {
    const { sendEmail: sendGmail } = await import('./email-sender.gmail.js');
    return sendGmail(transformed.to, transformed.subject, transformed.html, sendOptions);
  }

  // Mock mode
  const { sendEmail: sendMock } = await import('./email-sender.mock.js');
  const success = await sendMock(transformed.to, transformed.subject, transformed.html);
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

/**
 * Test mode interceptor.
 * When enabled, redirects all outbound emails to a safe test address.
 */

import { config } from '../config.js';

export interface EmailParams {
  to: string;
  subject: string;
  html: string;
}

/**
 * Transforms an email for test mode.
 * - Redirects `to` to all TEST_EMAIL_ADDRESS recipients (comma-separated)
 * - Prepends "[TEST]" to subject
 * - Adds a banner showing the original recipient
 */
export function applyTestMode(email: EmailParams, testModeOverride?: boolean, testEmailOverride?: string): EmailParams {
  const isTest = testModeOverride !== undefined ? testModeOverride : config.testMode.enabled;
  if (!isTest) return email;

  // testEmailOverride (from UI) takes priority over .env TEST_EMAIL_ADDRESS
  const rawTarget = testEmailOverride || config.testMode.testEmail;
  if (!rawTarget) {
    console.warn('[TestMode] test mode active but no test email configured — test mode skipped');
    return email;
  }

  // Support multiple comma-separated test addresses
  const testRecipients = rawTarget
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .join(', ');

  return {
    to: testRecipients,
    subject: `[TEST] ${email.subject}`,
    html: `<div style="background:#fef9c3;padding:10px 16px;margin-bottom:16px;border:1px solid #fbbf24;border-radius:6px;font-family:sans-serif;font-size:13px;">
  <strong>⚠ TEST MODE</strong> — Original recipient: <code>${email.to}</code>
</div>${email.html}`,
  };
}

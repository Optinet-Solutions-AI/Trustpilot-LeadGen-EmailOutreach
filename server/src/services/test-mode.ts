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
export function applyTestMode(email: EmailParams, testModeOverride?: boolean): EmailParams {
  const isTest = testModeOverride !== undefined ? testModeOverride : config.testMode.enabled;
  if (!isTest) return email;

  if (!config.testMode.testEmail) {
    console.warn('[TestMode] EMAIL_TEST_MODE=true but TEST_EMAIL_ADDRESS is not set — test mode skipped');
    return email;
  }

  // Support multiple comma-separated test addresses
  const testRecipients = config.testMode.testEmail
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

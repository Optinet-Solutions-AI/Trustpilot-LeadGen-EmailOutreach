/**
 * Cathy daily-preview notifier.
 *
 * Sends ONE email to CATHY_NOTIFICATION_EMAIL from NOTIFIER_FROM_EMAIL at the
 * start of each Manila workday listing the full day's planned warmup sends.
 * The notifier sender is loaded via getAccountForUtilitySend so an operator
 * status='paused' on that mailbox doesn't silence Cathy's preview.
 */

import { sendEmail } from '../email-sender.js';
import { getAccountForUtilitySend } from '../sender-loader.js';
import { CATHY_NOTIFICATION_EMAIL, NOTIFIER_FROM_EMAIL, WORKDAY } from './config.js';
import type { ScheduledSend } from './plan.js';

const TAG = '[ColleagueWarmup/Notifier]';

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: WORKDAY.timeZone,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatManila(d: Date): string {
  return timeFormatter.format(d);
}

export interface CathyPreviewInput {
  /** YYYY-MM-DD in Manila local time, for subject + heading. */
  dateKey: string;
  /** Three-letter weekday label, e.g. 'Mon'. */
  weekdayLabel: string;
  plan: ScheduledSend[];
}

export function buildCathyPreviewHtml(input: CathyPreviewInput): string {
  const rows = input.plan.map((s, i) => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;">${i + 1}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px;">${formatManila(s.send_at_utc)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px;">${escapeHtml(s.sender_email)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px;">${escapeHtml(s.recipient_email)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${escapeHtml(s.subject)}</td>
    </tr>`).join('');

  return `
<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f7f7f7;padding:24px;">
  <div style="max-width:840px;margin:0 auto;background:white;border-left:4px solid #2563eb;padding:20px 24px;">
    <h1 style="margin:0 0 8px;font-size:18px;color:#2563eb;">Colleague Warmup Plan</h1>
    <p style="margin:0 0 12px;color:#666;font-size:13px;">${escapeHtml(input.dateKey)} (${escapeHtml(input.weekdayLabel)}) — ${input.plan.length} sends scheduled, ${WORKDAY.startHour}:00–${WORKDAY.endHourExclusive}:00 Asia/Manila.</p>
    <div style="background:#fffbe6;border:1px solid #facc15;padding:10px 12px;border-radius:4px;font-size:13px;margin-bottom:16px;">
      <strong>Reminder for colleagues:</strong> Manually <strong>Reply</strong> and <strong>Forward</strong> each warmup. If it lands in Spam, leave it there — do NOT click “Not Spam”.
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#fafafa;border-bottom:2px solid #ddd;">
          <th style="text-align:right;padding:6px 8px;">#</th>
          <th style="text-align:left;padding:6px 8px;">Time (Manila)</th>
          <th style="text-align:left;padding:6px 8px;">Sender</th>
          <th style="text-align:left;padding:6px 8px;">Recipient</th>
          <th style="text-align:left;padding:6px 8px;">Subject</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px;color:#888;font-size:11px;">
      Sent by the OptiRate colleague-warmup scheduler. To stop, set COLLEAGUE_WARMUP_ENABLED=false on Cloud Run.
    </p>
  </div>
</body></html>`;
}

export async function sendCathyDailyPreview(input: CathyPreviewInput): Promise<boolean> {
  const senderAccount = await getAccountForUtilitySend(NOTIFIER_FROM_EMAIL);
  if (!senderAccount) {
    console.error(`${TAG} Notifier ${NOTIFIER_FROM_EMAIL} not found in email_accounts or missing creds — preview not sent.`);
    return false;
  }

  const subject = `Warmup plan for ${input.dateKey} (${input.weekdayLabel}) — ${input.plan.length} sends`;
  const html = buildCathyPreviewHtml(input);

  try {
    const result = await sendEmail(CATHY_NOTIFICATION_EMAIL, subject, html, {}, senderAccount);
    if (!result.success) {
      console.error(`${TAG} Send to ${CATHY_NOTIFICATION_EMAIL} failed:`, result.error ?? 'unknown');
      return false;
    }
    console.log(`${TAG} Preview sent to ${CATHY_NOTIFICATION_EMAIL} (${input.plan.length} sends)`);
    return true;
  } catch (err) {
    console.error(`${TAG} Send threw:`, err instanceof Error ? err.message : err);
    return false;
  }
}

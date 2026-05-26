/**
 * Duplicate-Send Monitor — Background watchdog that pages an operator when
 * the same (lead, campaign, step) tuple gets more than one `email_sent` note
 * in a short rolling window.
 *
 * Defense-in-depth on top of:
 *   - The atomic claim lock in sequence-scheduler.ts + campaign-scheduler.ts
 *   - The lead_notes idempotency guard before each send
 *   - The unique partial indexes from migration 040
 *
 * Why this exists: the 2026-05 incident shipped tens of duplicate sends
 * over two weeks before anyone noticed. The technical safeguards are now
 * stacked three layers deep, but human-visible alerting closes the gap —
 * if a future code path somehow bypasses all three layers, this catches
 * the duplicate within 5 minutes and pages the operator so they can hit
 * the EMAIL_SENDING_PAUSED_UNTIL kill switch before volume gets ugly.
 *
 * Two delivery channels are supported and can be combined:
 *   DUPLICATE_SEND_MONITOR_EMAIL        — recipient address for alerts.
 *                                          Use a mailbox NOT on the cold-
 *                                          outreach domain so a reputation
 *                                          incident on optiratesolutions.net
 *                                          can't silence its own alerts.
 *   DUPLICATE_SEND_MONITOR_FROM_EMAIL   — sender mailbox (must be an active
 *                                          row in email_accounts with valid
 *                                          creds). REQUIRED when EMAIL is
 *                                          set — the monitor refuses to
 *                                          fall back to the legacy env-only
 *                                          Gmail path, since that path
 *                                          historically resolved to a now-
 *                                          retired mailbox.
 *   DUPLICATE_SEND_MONITOR_WEBHOOK_URL  — POST target for Slack-compatible
 *                                          JSON payloads. Optional; useful
 *                                          when the team prefers a chat
 *                                          channel over email for incidents.
 *
 * Other knobs:
 *   DUPLICATE_SEND_MONITOR_INTERVAL_MS  — Poll interval (default 300000 = 5 min).
 *   DUPLICATE_SEND_MONITOR_WINDOW_MIN   — Rolling lookback window (default 5 min).
 *
 * Monitor is a no-op when BOTH email and webhook are unset.
 */

import { getSupabase } from '../lib/supabase.js';
import { sendEmail } from './email-sender.js';
import { getAccountForUtilitySend } from './sender-loader.js';

const POLL_INTERVAL_MS = Number(process.env.DUPLICATE_SEND_MONITOR_INTERVAL_MS) || 5 * 60 * 1000;
const WINDOW_MINUTES   = Number(process.env.DUPLICATE_SEND_MONITOR_WINDOW_MIN) || 5;

// In-process dedup: don't re-alert on the same tuple we already paged for in
// the last hour. Otherwise every 5-min tick would re-post the same alert as
// long as the duplicates remain in the lookback window. Map key is the
// canonical "(lead_id|campaign_id|step_number)" string.
const recentlyAlerted = new Map<string, number>();
const RE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

export interface DuplicateTuple {
  lead_id: string;
  campaign_id: string;
  step_number: string | null;
  sends: number;
  first_send: string;
  last_send: string;
}

export function startDuplicateSendMonitor(): void {
  const webhookUrl = process.env.DUPLICATE_SEND_MONITOR_WEBHOOK_URL;
  const emailAddr  = process.env.DUPLICATE_SEND_MONITOR_EMAIL;
  if (!webhookUrl && !emailAddr) {
    console.log('[DuplicateSendMonitor] Neither DUPLICATE_SEND_MONITOR_EMAIL nor DUPLICATE_SEND_MONITOR_WEBHOOK_URL set — monitor disabled');
    return;
  }

  const channels: string[] = [];
  if (emailAddr)  channels.push(`email→${emailAddr}`);
  if (webhookUrl) channels.push(`webhook→${redactUrl(webhookUrl)}`);
  console.log(`[DuplicateSendMonitor] Started — polling every ${POLL_INTERVAL_MS / 1000}s, ${WINDOW_MINUTES}-min lookback, channels: ${channels.join(', ')}`);

  setInterval(async () => {
    try {
      await checkForDuplicates();
    } catch (err) {
      console.error('[DuplicateSendMonitor] Tick error:', err instanceof Error ? err.message : err);
    }
  }, POLL_INTERVAL_MS);
}

async function checkForDuplicates(): Promise<void> {
  const supabase = getSupabase();
  const sinceIso = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();

  // Pull every email_sent note in the lookback window. We aggregate in
  // application code instead of via SQL group-by because the supabase-js
  // builder doesn't expose HAVING cleanly across jsonb keys. The volume
  // is bounded (at most a few hundred sends in 5 minutes during peak),
  // so the in-memory grouping is cheap.
  const { data: recentNotes, error } = await supabase
    .from('lead_notes')
    .select('lead_id, metadata, created_at')
    .eq('type', 'email_sent')
    .gte('created_at', sinceIso);

  if (error) {
    console.error('[DuplicateSendMonitor] Query error:', error.message);
    return;
  }
  if (!recentNotes || recentNotes.length === 0) return;

  // Group by (lead_id, campaign_id, step_number) — step_number is null for
  // initial sends. Matches the partition keys of the unique indexes from
  // migration 040, so we're catching the exact same dedup violations.
  const groups = new Map<string, DuplicateTuple>();
  for (const note of recentNotes) {
    const lead_id = note.lead_id as string;
    const metadata = (note.metadata as Record<string, unknown> | null) ?? {};
    const campaign_id = (metadata['campaign_id'] as string | undefined) ?? '';
    const step_number = (metadata['step_number'] as string | number | undefined) ?? null;
    const created_at = note.created_at as string;
    if (!campaign_id) continue;
    const key = `${lead_id}|${campaign_id}|${step_number ?? 'initial'}`;
    const existing = groups.get(key);
    if (existing) {
      existing.sends += 1;
      if (created_at < existing.first_send) existing.first_send = created_at;
      if (created_at > existing.last_send)  existing.last_send  = created_at;
    } else {
      groups.set(key, {
        lead_id, campaign_id,
        step_number: step_number === null ? null : String(step_number),
        sends: 1, first_send: created_at, last_send: created_at,
      });
    }
  }

  const duplicates = Array.from(groups.entries())
    .filter(([_, v]) => v.sends > 1)
    .map(([key, v]) => ({ key, ...v }));

  if (duplicates.length === 0) return;

  // Filter out tuples we already alerted on recently — prevents alert spam
  // when the lookback window straddles the original burst across multiple
  // ticks.
  const now = Date.now();
  for (const [key, ts] of recentlyAlerted) {
    if (now - ts > RE_ALERT_COOLDOWN_MS) recentlyAlerted.delete(key);
  }
  const fresh = duplicates.filter((d) => !recentlyAlerted.has(d.key));
  if (fresh.length === 0) {
    console.log(`[DuplicateSendMonitor] ${duplicates.length} duplicate tuples detected but all are within the alert-cooldown window`);
    return;
  }
  for (const d of fresh) recentlyAlerted.set(d.key, now);

  console.warn(`[DuplicateSendMonitor] ALERT — ${fresh.length} new duplicate tuple(s) detected in last ${WINDOW_MINUTES} min`);
  await postAlert(fresh);
}

/**
 * Send an alert to whichever channels are configured (email + webhook).
 * Exported so an admin route or one-off script can fire a synthetic alert
 * for testing without inserting fake DB rows.
 */
export async function postAlert(duplicates: Array<DuplicateTuple & { key: string }>): Promise<{ email: boolean; webhook: boolean }> {
  const webhookUrl = process.env.DUPLICATE_SEND_MONITOR_WEBHOOK_URL;
  const emailAddr  = process.env.DUPLICATE_SEND_MONITOR_EMAIL;

  const totalExcess = duplicates.reduce((sum, d) => sum + (d.sends - 1), 0);
  const summary = `${duplicates.length} tuple(s), ~${totalExcess} excess sends`;

  const [webhookOk, emailOk] = await Promise.all([
    webhookUrl ? postSlackWebhook(webhookUrl, duplicates, summary) : Promise.resolve(false),
    emailAddr  ? postEmail(emailAddr, duplicates, summary)         : Promise.resolve(false),
  ]);
  return { email: emailOk, webhook: webhookOk };
}

async function postSlackWebhook(
  webhookUrl: string,
  duplicates: Array<DuplicateTuple & { key: string }>,
  summary: string,
): Promise<boolean> {
  const lines = duplicates.slice(0, 20).map((d) => {
    const stepLabel = d.step_number === null ? 'initial' : `step ${d.step_number}`;
    const span = (new Date(d.last_send).getTime() - new Date(d.first_send).getTime()) / 1000;
    return `• lead=\`${d.lead_id}\` campaign=\`${d.campaign_id}\` ${stepLabel} — *${d.sends} sends* in ${span.toFixed(1)}s`;
  }).join('\n');

  const overflowNote = duplicates.length > 20 ? `\n_+${duplicates.length - 20} more not shown_` : '';

  const payload = {
    text: `⚠️ Duplicate email_sent detected — ${summary}`,
    attachments: [{
      color: 'danger',
      title: `Duplicate-Send Monitor — ${new Date().toISOString()}`,
      text: lines + overflowNote,
      footer: 'Hit EMAIL_SENDING_PAUSED_UNTIL kill switch immediately if this is a runaway',
    }],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[DuplicateSendMonitor] Webhook POST returned ${res.status}: ${await res.text().catch(() => '<no body>')}`);
      return false;
    }
    console.log(`[DuplicateSendMonitor] Webhook alert posted (${duplicates.length} tuples)`);
    return true;
  } catch (err) {
    console.error('[DuplicateSendMonitor] Webhook POST failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

async function postEmail(
  toAddr: string,
  duplicates: Array<DuplicateTuple & { key: string }>,
  summary: string,
): Promise<boolean> {
  // Require an explicit sender. The legacy 3-arg sendEmail() call would fall
  // through to the env-default Gmail OAuth path (config.gmail.fromEmail), but
  // that env var historically pointed at a retired mailbox
  // (angelicarose549@gmail.com). Better to refuse to send than silently put a
  // dead address in the From header of alert mail (which is itself a
  // deliverability signal — recipient ESPs flag retired senders with hard
  // bounces against their domain reputation).
  const fromEmail = process.env.DUPLICATE_SEND_MONITOR_FROM_EMAIL;
  if (!fromEmail) {
    console.error('[DuplicateSendMonitor] DUPLICATE_SEND_MONITOR_FROM_EMAIL not set — refusing to send alert via env-default Gmail (which is retired). Set it to the email of an active row in email_accounts.');
    return false;
  }
  // getAccountForUtilitySend bypasses the status='active' + is_cold_sender
  // filters that getSenderAccountByEmail enforces. Monitor alerts must be
  // able to fire even when the operator has paused cold sending (in fact
  // ESPECIALLY then — that's when monitoring matters most), and warmup peers
  // are legitimate alert senders. Still requires valid creds.
  const senderAccount = await getAccountForUtilitySend(fromEmail);
  if (!senderAccount) {
    console.error(`[DuplicateSendMonitor] Sender ${fromEmail} not found in email_accounts or missing creds — refusing to send alert. Confirm the row exists with valid auth_type credentials.`);
    return false;
  }

  const rows = duplicates.slice(0, 50).map((d) => {
    const stepLabel = d.step_number === null ? 'initial' : `step ${d.step_number}`;
    const span = (new Date(d.last_send).getTime() - new Date(d.first_send).getTime()) / 1000;
    return `
      <tr>
        <td style="font-family:monospace;font-size:12px;padding:4px 8px;border-bottom:1px solid #eee;">${escapeHtml(d.lead_id)}</td>
        <td style="font-family:monospace;font-size:12px;padding:4px 8px;border-bottom:1px solid #eee;">${escapeHtml(d.campaign_id)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;">${stepLabel}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;"><strong>${d.sends}</strong></td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;">${span.toFixed(1)}s</td>
      </tr>`;
  }).join('');

  const overflowNote = duplicates.length > 50
    ? `<p style="color:#888;font-size:12px;font-style:italic;">+${duplicates.length - 50} more tuples not shown — query lead_notes directly for the full list.</p>`
    : '';

  const subject = `[OptiRate Monitor] Duplicate email_sent detected — ${summary}`;
  const html = `
<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f7f7f7;padding:24px;">
  <div style="max-width:720px;margin:0 auto;background:white;border-left:4px solid #d12d2d;padding:20px 24px;">
    <h1 style="margin:0 0 8px;font-size:18px;color:#d12d2d;">⚠️ Duplicate-Send Monitor Alert</h1>
    <p style="margin:0 0 16px;color:#666;font-size:13px;">Triggered at ${escapeHtml(new Date().toISOString())} — ${escapeHtml(summary)}</p>
    <p style="margin:0 0 12px;font-size:14px;">
      The duplicate-send monitor detected more than one <code>email_sent</code> note for the same
      <code>(lead, campaign, step)</code> tuple in the last ${WINDOW_MINUTES} minutes.
      If this is a runaway, hit the kill switch immediately:
    </p>
    <pre style="background:#272822;color:#f8f8f2;padding:12px;border-radius:4px;font-size:12px;overflow-x:auto;">gcloud run services update trustpilot-crm --region us-central1 \\
  --project=trustpilot-leadgen \\
  --update-env-vars "EMAIL_SENDING_PAUSED_UNTIL=$(date -u -v+24H +'%Y-%m-%dT%H:%M:%SZ')"</pre>
    <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:13px;">
      <thead>
        <tr style="background:#fafafa;border-bottom:2px solid #ddd;">
          <th style="text-align:left;padding:6px 8px;">lead_id</th>
          <th style="text-align:left;padding:6px 8px;">campaign_id</th>
          <th style="text-align:left;padding:6px 8px;">step</th>
          <th style="text-align:right;padding:6px 8px;">sends</th>
          <th style="text-align:right;padding:6px 8px;">span</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${overflowNote}
    <p style="margin-top:16px;color:#888;font-size:11px;">
      Sent by the OptiRate duplicate-send monitor.
      Configured via DUPLICATE_SEND_MONITOR_EMAIL on Cloud Run service trustpilot-crm.
    </p>
  </div>
</body></html>`;

  try {
    const result = await sendEmail(toAddr, subject, html, {}, senderAccount);
    if (!result.success) {
      console.error(`[DuplicateSendMonitor] Email alert from ${fromEmail} to ${toAddr} failed:`, result.error ?? 'unknown error');
      return false;
    }
    console.log(`[DuplicateSendMonitor] Email alert sent from ${fromEmail} to ${toAddr} (${duplicates.length} tuples)`);
    return true;
  } catch (err) {
    console.error('[DuplicateSendMonitor] Email send threw:', err instanceof Error ? err.message : err);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Redact any embedded auth tokens / Slack secrets before logging the URL
function redactUrl(url: string): string {
  return url.replace(/(\/services\/[^/]+\/[^/]+\/)[^/]+$/, '$1***');
}

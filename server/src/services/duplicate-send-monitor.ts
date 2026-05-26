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
 * the duplicate within 5 minutes and posts to an alerts webhook so the
 * operator can hit the EMAIL_SENDING_PAUSED_UNTIL kill switch before
 * volume gets ugly.
 *
 * Configuration:
 *   DUPLICATE_SEND_MONITOR_WEBHOOK_URL  — POST target for alerts (Slack
 *                                          incoming-webhook, Discord, or
 *                                          any URL that accepts JSON).
 *                                          Monitor is a no-op when unset.
 *   DUPLICATE_SEND_MONITOR_INTERVAL_MS  — Poll interval (default 300000 = 5 min).
 *   DUPLICATE_SEND_MONITOR_WINDOW_MIN   — Rolling lookback window (default 5 min).
 *
 * Alert payload shape (Slack-compatible):
 *   {
 *     text: "⚠️ Duplicate email_sent detected (3 tuples affected)",
 *     attachments: [
 *       { color: 'danger', fields: [{ title, value }...] }
 *     ]
 *   }
 *
 * If you don't have a webhook handy, point this at a free https://webhook.site
 * URL for testing — payloads show up live in the browser.
 */

import { getSupabase } from '../lib/supabase.js';

const POLL_INTERVAL_MS = Number(process.env.DUPLICATE_SEND_MONITOR_INTERVAL_MS) || 5 * 60 * 1000;
const WINDOW_MINUTES   = Number(process.env.DUPLICATE_SEND_MONITOR_WINDOW_MIN) || 5;

// In-process dedup: don't re-alert on the same tuple we already paged for in
// the last hour. Otherwise every 5-min tick would re-post the same alert as
// long as the duplicates remain in the lookback window. Map key is the
// canonical "(lead_id|campaign_id|step_number)" string.
const recentlyAlerted = new Map<string, number>();
const RE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

interface DuplicateTuple {
  lead_id: string;
  campaign_id: string;
  step_number: string | null;
  sends: number;
  first_send: string;
  last_send: string;
}

export function startDuplicateSendMonitor(): void {
  const webhookUrl = process.env.DUPLICATE_SEND_MONITOR_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[DuplicateSendMonitor] DUPLICATE_SEND_MONITOR_WEBHOOK_URL unset — monitor disabled');
    return;
  }

  console.log(`[DuplicateSendMonitor] Started — polling every ${POLL_INTERVAL_MS / 1000}s, ${WINDOW_MINUTES}-minute lookback window, posting alerts to ${redactUrl(webhookUrl)}`);

  setInterval(async () => {
    try {
      await checkForDuplicates(webhookUrl);
    } catch (err) {
      console.error('[DuplicateSendMonitor] Tick error:', err instanceof Error ? err.message : err);
    }
  }, POLL_INTERVAL_MS);
}

async function checkForDuplicates(webhookUrl: string): Promise<void> {
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
  await postAlert(webhookUrl, fresh);
}

async function postAlert(webhookUrl: string, duplicates: Array<DuplicateTuple & { key: string }>): Promise<void> {
  const totalExcess = duplicates.reduce((sum, d) => sum + (d.sends - 1), 0);
  const lines = duplicates.slice(0, 20).map((d) => {
    const stepLabel = d.step_number === null ? 'initial' : `step ${d.step_number}`;
    const span = (new Date(d.last_send).getTime() - new Date(d.first_send).getTime()) / 1000;
    return `• lead=\`${d.lead_id}\` campaign=\`${d.campaign_id}\` ${stepLabel} — *${d.sends} sends* in ${span.toFixed(1)}s`;
  }).join('\n');

  const overflowNote = duplicates.length > 20
    ? `\n_+${duplicates.length - 20} more not shown_`
    : '';

  const payload = {
    text: `⚠️ Duplicate email_sent detected — ${duplicates.length} tuple(s), ~${totalExcess} excess sends`,
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
    } else {
      console.log(`[DuplicateSendMonitor] Alert posted (${duplicates.length} tuples)`);
    }
  } catch (err) {
    console.error('[DuplicateSendMonitor] Webhook POST failed:', err instanceof Error ? err.message : err);
  }
}

// Redact any embedded auth tokens / Slack secrets before logging the URL
function redactUrl(url: string): string {
  return url.replace(/(\/services\/[^/]+\/[^/]+\/)[^/]+$/, '$1***');
}

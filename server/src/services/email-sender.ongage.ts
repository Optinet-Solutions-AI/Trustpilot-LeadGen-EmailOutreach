/**
 * Ongage transactional email sender (Option A — Ongage as the sending engine).
 *
 * Sends each already-rendered, already-personalized email as an individual
 * transactional message through Ongage's API, which fronts the delivery vendor
 * (InboxRoad / Ongage SMTP). This keeps the app's campaign wizard, spintax,
 * sequences, test flight, caps and reply tracking exactly as they are — only
 * the final dispatch changes from Gmail/SMTP to Ongage.
 *
 *   POST https://api.ongage.com/<list_id>/api/transactional/send_embed_content
 *   header: x-api-key: <ONGAGE_API_KEY>
 *   body:  { sending_connection_id, recipients:[to],
 *            message:{ subject, content_html, addresses:{from_name, from_address, reply_address} } }
 *
 * The sending connection (a warmed sending domain) is resolved per-sender from
 * ONGAGE_SENDERS; each pool account (grace@/ethan@/lily@…) maps to its Ongage
 * connection id, so the scheduler's rotation + per-account caps drive which
 * domain sends. Falls back to ONGAGE_SENDING_CONNECTION_ID.
 */
import type { SendEmailOptions, SendEmailResult } from './email-sender.gmail.js';

export interface OngageSenderAccount {
  email: string;      // from_address, e.g. lily@rp.optiratesolutions.net
  fromName: string;   // from_name
  auth_type: 'ongage';
  /** Optional explicit Ongage sending_connection_id; when absent it's resolved
   *  from ONGAGE_SENDERS by email, then ONGAGE_SENDING_CONNECTION_ID. */
  ongage_connection_id?: number | null;
  /** Optional reply-to; defaults to the from address. Point at a monitored
   *  mailbox if the sending domain is send-only. */
  ongage_reply_to?: string | null;
}

interface OngageSenderEntry { connectionId: number; fromName?: string }

/** Parse ONGAGE_SENDERS ("conn_id:from_address:from_name, ...") into a map
 *  keyed by lower-cased from address. */
function parseSenders(): Map<string, OngageSenderEntry> {
  const map = new Map<string, OngageSenderEntry>();
  const raw = process.env.ONGAGE_SENDERS || '';
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const [connStr, email, ...nameParts] = seg.split(':');
    const connectionId = parseInt((connStr || '').trim(), 10);
    const addr = (email || '').trim().toLowerCase();
    if (!connectionId || !addr) continue;
    map.set(addr, { connectionId, fromName: nameParts.join(':').trim() || undefined });
  }
  return map;
}

function ongageConfig() {
  const base = (process.env.ONGAGE_API_BASE || 'https://api.ongage.com').trim().replace(/\/+$/, '');
  const apiKey = (process.env.ONGAGE_API_KEY || '').trim();
  const listId = (process.env.ONGAGE_LIST_ID || '').trim();
  // parseInt tolerates a trailing inline comment on the env value.
  const defaultConn = parseInt((process.env.ONGAGE_SENDING_CONNECTION_ID || '').trim(), 10) || null;
  return { base, apiKey, listId, defaultConn, senders: parseSenders() };
}

function resolveConnectionId(account: OngageSenderAccount, cfg: ReturnType<typeof ongageConfig>): number | null {
  if (account.ongage_connection_id) return account.ongage_connection_id;
  const entry = cfg.senders.get((account.email || '').toLowerCase());
  return entry?.connectionId ?? cfg.defaultConn;
}

/** The app's SMTP/Gmail senders APPEND the lead screenshot as an inline CID
 *  image (the template body itself has no <img>). Ongage's transactional API
 *  takes raw HTML with no attachments, so append the same image as a normal
 *  <img> pointing at the public screenshot URL (screenshots are public Supabase
 *  URLs). Mirrors email-sender.smtp.ts's markup. No-op without an http
 *  screenshot; also swaps any stray cid: ref for the URL, defensively. */
function embedScreenshot(html: string, screenshotPath?: string): string {
  if (!screenshotPath || !screenshotPath.startsWith('http')) return html;
  let out = html;
  if (/cid:[^"'\s>]+/i.test(out)) out = out.replace(/cid:[^"'\s>]+/gi, screenshotPath);
  if (!out.includes(screenshotPath)) {
    out += `\n<br/><img src="${screenshotPath}" alt="Your Trustpilot Profile" ` +
      `style="width:100%;max-width:550px;height:auto;border:1px solid #e2e8f0;border-radius:8px;display:block;margin-top:12px;" />`;
  }
  return out;
}

export async function sendEmailOngage(
  to: string,
  subject: string,
  html: string,
  options: SendEmailOptions = {},
  account: OngageSenderAccount,
): Promise<SendEmailResult> {
  const cfg = ongageConfig();
  if (!cfg.apiKey || !cfg.listId) {
    return { success: false, error: 'Ongage not configured (ONGAGE_API_KEY / ONGAGE_LIST_ID missing)' };
  }
  const connectionId = resolveConnectionId(account, cfg);
  if (!connectionId) {
    return { success: false, error: `No Ongage sending_connection_id for ${account.email} (set ONGAGE_SENDERS or ONGAGE_SENDING_CONNECTION_ID)` };
  }

  const replyTo = account.ongage_reply_to || account.email;
  // Cold 1:1 service-offer style: no visible unsubscribe footer from our side
  // (that reads as bulk mail). Opt-out/compliance is handled at the ESP
  // (List-Unsubscribe) or via reply. Just embed the screenshot.
  const bodyHtml = embedScreenshot(html, options.screenshotPath);

  const url = `${cfg.base}/${cfg.listId}/api/transactional/send_embed_content`;
  const payload = {
    sending_connection_id: connectionId,
    recipients: [to],
    message: {
      subject,
      content_html: bodyHtml,
      addresses: {
        from_name: account.fromName || 'OptiRate',
        from_address: account.email,
        reply_address: replyTo,
      },
    },
  };

  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({} as Record<string, unknown>));
      const meta = (json as { metadata?: { error?: boolean } }).metadata;
      const pl = (json as { payload?: { success?: number; failed?: number; message?: string; failed_emails?: unknown[] } }).payload;

      if (res.ok && meta && meta.error === false && (pl?.success ?? 0) >= 1) {
        console.log(`[Ongage] sent to ${to} via conn ${connectionId} (${account.email})`);
        return { success: true };
      }

      lastError = `HTTP ${res.status}: ${pl?.message || JSON.stringify(json).slice(0, 200)}`;
      // 4xx (validation/auth) won't succeed on retry — fail fast.
      if (res.status >= 400 && res.status < 500) {
        console.warn(`[Ongage] send to ${to} failed (no retry): ${lastError}`);
        return { success: false, error: lastError };
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  console.warn(`[Ongage] send to ${to} failed after retries: ${lastError}`);
  return { success: false, error: lastError };
}

/**
 * Hunter.io Email-Verifier adapter — Stage 7 fallback used only when ZeroBounce
 * AND MillionVerifier both returned `unknown`. By design this is the smallest
 * funnel of the three paid verifiers, since the earlier stages already
 * eliminate definitive verdicts.
 *
 * Cost discipline (Hunter free tier is only 50 calls/month, paid Starter is
 * 500/month at $34, so we burn credits sparingly):
 *   - Skip free-provider domains (gmail/yahoo/outlook/etc.) — Hunter labels
 *     them risky/catch-all anyway and the call doesn't add information
 *   - Skip role addresses (already classified as catch-all by upstream stages)
 *   - Per-process soft cap (HUNTER_MAX_CALLS_PER_HOUR) to bound bursts
 *
 * Env-gated: silently no-ops when HUNTER_API_KEY is unset.
 *
 * API docs: https://hunter.io/api-documentation/v2#email-verifier
 */

import https from 'node:https';

type FinalStatus = 'valid' | 'invalid' | 'catch-all' | 'unknown';

interface HunterEnvelope {
  data?: {
    status?: string;             // 'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown'
    result?: string;             // 'deliverable' | 'undeliverable' | 'risky' | 'unknown'
    score?: number;              // 0-100 confidence
    email?: string;
    regexp?: boolean;
    gibberish?: boolean;
    disposable?: boolean;
    webmail?: boolean;
    mx_records?: boolean;
    smtp_server?: boolean;
    smtp_check?: boolean;
    accept_all?: boolean;
    block?: boolean;
  };
  errors?: Array<{ id?: string; code?: number; details?: string }>;
  meta?: { params?: Record<string, unknown> };
}

export interface HunterVerifyResult {
  email: string;
  status: FinalStatus;
  raw: {
    status: string | undefined;
    result: string | undefined;
    score: number | undefined;
    accept_all: boolean | undefined;
    webmail: boolean | undefined;
    disposable: boolean | undefined;
  };
}

// Free-mailbox providers — Hunter charges a credit per call but gives us no
// information we don't already have (these are catch-all by definition for
// outreach purposes). Mirrors FREE_EMAIL_DOMAINS from website-enricher.ts but
// kept local so this module has zero cross-feature imports.
const SKIP_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.es',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr',
  'outlook.com', 'outlook.fr', 'outlook.de',
  'live.com', 'live.co.uk',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'mail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
  'protonmail.com', 'proton.me', 'pm.me',
  'yandex.com', 'yandex.ru', 'mail.ru',
  'zoho.com', 'fastmail.com',
]);

// Per-process rate limiter — bounds bursts when a campaign verify spikes
// (e.g. user clicks "verify all 200 leads"). Resets every rolling hour.
// Goal: stay well under the monthly cap even in worst-case usage.
const MAX_CALLS_PER_HOUR = +(process.env.HUNTER_MAX_CALLS_PER_HOUR ?? '20');
const _callTimestamps: number[] = [];
function withinBudget(): boolean {
  const now = Date.now();
  const cutoff = now - 60 * 60_000;
  while (_callTimestamps.length && _callTimestamps[0] < cutoff) _callTimestamps.shift();
  return _callTimestamps.length < MAX_CALLS_PER_HOUR;
}
function recordCall(): void {
  _callTimestamps.push(Date.now());
}

/**
 * Map Hunter's verdict fields onto our 4-value FinalStatus.
 *
 * Hunter splits the answer across two fields:
 *   - status:  'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown'
 *   - result:  'deliverable' | 'undeliverable' | 'risky' | 'unknown'
 *
 * Decision logic (conservative — never silently upgrade to valid):
 *   - status='invalid' OR result='undeliverable'    → invalid
 *   - status='accept_all'                            → catch-all
 *   - status='valid' AND result='deliverable'       → valid
 *   - everything else (risky, unknown, webmail-as-status, disposable) → unknown
 */
function mapStatus(env: NonNullable<HunterEnvelope['data']>): FinalStatus {
  const status = (env.status ?? '').toLowerCase();
  const result = (env.result ?? '').toLowerCase();

  if (status === 'invalid' || result === 'undeliverable') return 'invalid';
  if (status === 'accept_all' || env.accept_all === true) return 'catch-all';
  if (status === 'valid' && result === 'deliverable') return 'valid';
  return 'unknown';
}

export function hunterVerifyEnabled(): boolean {
  return !!(process.env.HUNTER_API_KEY && process.env.HUNTER_API_KEY.trim());
}

function fetchJson(url: string, timeoutMs: number): Promise<HunterEnvelope | null> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve(null); return; }
    const req = https.get(parsed, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'OptiRate-Validator/1.0', 'Accept': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 500) { resolve(null); return; }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as HunterEnvelope);
        } catch {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Verify a single email via Hunter's email-verifier endpoint.
 *
 * Returns null when:
 *   - HUNTER_API_KEY isn't set
 *   - Domain is on SKIP_DOMAINS (free webmail provider — call adds nothing)
 *   - Per-process rate budget is exhausted
 *   - Network error / parse failure
 *
 * The caller treats null as "no verdict — keep upstream stage's answer."
 */
export async function verifyEmailHunter(email: string): Promise<HunterVerifyResult | null> {
  const apiKey = process.env.HUNTER_API_KEY?.trim();
  if (!apiKey) return null;

  const norm = email.trim().toLowerCase();
  const domain = norm.split('@')[1];
  if (!domain) return null;
  if (SKIP_DOMAINS.has(domain)) {
    // Free webmail — don't burn a credit. The validator's catch-all stage
    // already classifies these correctly without third-party help.
    return null;
  }

  if (!withinBudget()) {
    console.warn(`[hunter:verify] hourly cap (${MAX_CALLS_PER_HOUR}) hit — skipping ${norm}`);
    return null;
  }

  const url = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(norm)}` +
    `&api_key=${encodeURIComponent(apiKey)}`;

  recordCall();
  const env = await fetchJson(url, 10_000);
  if (!env) return null;

  if (env.errors && env.errors.length > 0) {
    const first = env.errors[0];
    console.warn(`[hunter:verify] error for ${norm}: ${first.id ?? first.code ?? '?'} ${first.details ?? ''}`.trim());
    // 429 = rate limited / quota exhausted — the surrounding logic should
    // treat null as "no verdict" rather than silently flipping the lead.
    return null;
  }

  const data = env.data;
  if (!data) return null;

  return {
    email: norm,
    status: mapStatus(data),
    raw: {
      status: data.status,
      result: data.result,
      score: data.score,
      accept_all: data.accept_all,
      webmail: data.webmail,
      disposable: data.disposable,
    },
  };
}

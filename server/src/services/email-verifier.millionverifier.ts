/**
 * MillionVerifier adapter — second-pass verifier used as Stage 6 fallback when
 * ZeroBounce returns `unknown`. Different intel sources resolve different
 * unknown cases; MillionVerifier is particularly strong on relay/forwarder
 * domains (ImprovMX, ForwardEmail) where ZB's data is sparse.
 *
 * Env-gated: silently no-ops when MILLIONVERIFIER_API_KEY is unset, so this
 * ships safely before the user signs up for a free 1,000-credit account at
 * https://app.millionverifier.com — once the env var is added on Cloud Run
 * the validator picks it up on the next request, no redeploy needed.
 *
 * API docs: https://app.millionverifier.com/integrations
 */

import https from 'https';

type FinalStatus = 'valid' | 'invalid' | 'catch-all' | 'unknown';

interface MvResponse {
  email?: string;
  // result is the canonical verdict; result_code is a numeric mirror.
  // Possible result values per docs:
  //   ok | catch_all | unknown | error | disposable | invalid
  result?: string;
  result_code?: number;
  // quality is a coarse "good | risky | bad | unknown" hint we don't use directly
  quality?: string;
  // free, role are flags we surface for diagnostics but don't change verdict on
  free?: boolean;
  role?: boolean;
  didyoumean?: string;
  error?: string;
}

export interface MillionVerifierResult {
  email: string;
  status: FinalStatus;
  // Provider-specific raw fields surfaced for the audit note
  raw: Pick<MvResponse, 'result' | 'quality' | 'free' | 'role' | 'didyoumean' | 'error'>;
}

// `disposable` is a domain-level provider flag (the address is hosted on a
// temp-mail provider per
// https://help.millionverifier.com/email-verification/email-verification-results),
// not proof the mailbox is dead today. Demoting to `unknown` keeps the lead
// selectable so the user can opt-in per campaign rather than the validator
// silently silencing them. The hard-undeliverable cases (`invalid`) still
// short-circuit to `invalid`.
function mapStatus(result: string | undefined): FinalStatus {
  switch ((result ?? '').toLowerCase()) {
    case 'ok':           return 'valid';
    case 'invalid':      return 'invalid';
    case 'disposable':   return 'unknown';
    case 'catch_all':    return 'catch-all';
    case 'unknown':
    case 'error':
    case '':
    default:             return 'unknown';
  }
}

/**
 * Returns true when MILLIONVERIFIER_API_KEY is set (i.e. the adapter is live).
 * Used by the orchestrator to decide whether to invoke this stage at all.
 */
export function millionVerifierEnabled(): boolean {
  return !!(process.env.MILLIONVERIFIER_API_KEY && process.env.MILLIONVERIFIER_API_KEY.trim());
}

function fetchJson(url: string, timeoutMs: number): Promise<MvResponse | null> {
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
        if (res.statusCode !== 200) { resolve(null); return; }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as MvResponse);
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
 * Verify a single email via MillionVerifier's single-address endpoint.
 * Returns null if the API key isn't set, the request fails, or the response
 * is malformed — the caller should treat null as "no verdict, don't override
 * the upstream stage."
 */
export async function verifyEmailMv(email: string): Promise<MillionVerifierResult | null> {
  const apiKey = process.env.MILLIONVERIFIER_API_KEY?.trim();
  if (!apiKey) return null;

  const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(apiKey)}` +
    `&email=${encodeURIComponent(email)}&timeout=10`;
  const body = await fetchJson(url, 12_000);
  if (!body) return null;

  // API-side error (rate limit, invalid key, etc.) — treat as no verdict
  if (body.error) {
    console.warn(`[mv] error for ${email}: ${body.error}`);
    return null;
  }

  return {
    email,
    status: mapStatus(body.result),
    raw: {
      result: body.result,
      quality: body.quality,
      free: body.free,
      role: body.role,
      didyoumean: body.didyoumean,
      error: body.error,
    },
  };
}

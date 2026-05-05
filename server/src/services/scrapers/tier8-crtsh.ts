/**
 * Tier 8 — crt.sh certificate-transparency scan.
 *
 * Final low-yield fallback: queries crt.sh for every TLS cert ever issued for
 * the domain and scans the cert subjects + SANs for embedded admin emails.
 * Some registrars (and historical OV/EV cert issuance) put a real contact
 * email in the cert's organization fields. Free, no auth, no key.
 *
 * Usually fires last because hits are rare — most modern certs use DNS or
 * file-based domain validation and contain no email at all. But occasionally
 * surfaces a working address on an old enterprise/ccTLD domain that all the
 * earlier tiers missed.
 */

import https from 'node:https';

const TIMEOUT_MS = 8_000;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

const REJECT_PREFIXES = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
  'postmaster', 'mailer-daemon', 'bounce', 'bounces', 'abuse',
  'spam', 'unsubscribe', 'webmaster',
]);

// crt.sh frequently returns these registrar / CA / privacy-proxy emails in the
// org fields — they're not the operator we want to reach.
const REJECT_DOMAINS = new Set([
  'sectigo.com', 'comodo.com', 'comodoca.com', 'digicert.com', 'letsencrypt.org',
  'globalsign.com', 'godaddy.com', 'namecheap.com', 'cloudflare.com',
  'whoisguard.com', 'domainsbyproxy.com', 'withheldforprivacy.com',
  'whoisprivacyprotect.com', 'whoisprivacycorp.com', 'contactprivacy.com',
]);

function extractDomain(websiteUrl: string): string | null {
  try {
    const trimmed = websiteUrl.trim();
    const withProtocol = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    const hostname = new URL(withProtocol).hostname.replace(/^www\./, '');
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    const secondLast = parts[parts.length - 2];
    if (secondLast.length <= 3 && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  } catch {
    return null;
  }
}

function httpGetJson(rawUrl: string, timeoutMs: number): Promise<unknown | null> {
  return new Promise((resolve) => {
    let url: URL;
    try { url = new URL(rawUrl); } catch { resolve(null); return; }

    const req = https.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OptiRateBot/1.0)',
        'Accept': 'application/json',
      },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
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

export interface Tier8Result {
  email: string | null;
  source?: string;
}

export async function tier8CrtshLookup(websiteUrl: string): Promise<Tier8Result> {
  const domain = extractDomain(websiteUrl);
  if (!domain) return { email: null };

  const data = await httpGetJson(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`, TIMEOUT_MS);
  if (!Array.isArray(data) || data.length === 0) {
    console.log(`    [tier8] no crt.sh data for ${domain}`);
    return { email: null };
  }

  // Concatenate every string field across every cert entry — the email could
  // be in name_value, common_name, issuer_name, or buried elsewhere.
  const blob = data
    .map((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return '';
      return Object.values(entry as Record<string, unknown>)
        .filter((v): v is string => typeof v === 'string')
        .join(' ');
    })
    .join(' ');

  const dom = domain.toLowerCase();
  const found = new Set<string>();
  for (const m of blob.match(EMAIL_RE) || []) {
    const lower = m.toLowerCase();
    const at = lower.indexOf('@');
    if (at < 0) continue;
    const prefix = lower.slice(0, at);
    const emailDomain = lower.slice(at + 1);
    if (REJECT_PREFIXES.has(prefix)) continue;
    if (REJECT_DOMAINS.has(emailDomain)) continue;
    if (emailDomain !== dom && !emailDomain.endsWith('.' + dom)) continue;
    found.add(lower);
  }

  if (found.size === 0) {
    console.log(`    [tier8] no operator email in crt.sh for ${domain}`);
    return { email: null };
  }

  const best = [...found][0];
  console.log(`    [tier8] hit for ${domain}: ${best}`);
  return { email: best, source: 'crtsh' };
}

/**
 * Tier 9 — Hunter.io domain-search fallback.
 *
 * Last-resort metadata lookup for domains that block every scraping path.
 * Hunter aggregates emails from public sources (LinkedIn, news articles,
 * press releases, GitHub commits) — no scraping required, so Cloudflare
 * doesn't matter at all.
 *
 * Free tier: 50 domain searches per month, permanent. We hit it only after
 * Tiers 1.5/2/5/5b/6/7/8 all return null, so consumption is bounded by the
 * count of fully-blocked sites in a batch (typically <10% of leads).
 *
 * Disabled silently when HUNTER_API_KEY is unset.
 */

import https from 'node:https';

const HUNTER_BASE = 'https://api.hunter.io/v2/domain-search';
const HUNTER_TIMEOUT_MS = 10_000;
const HUNTER_LIMIT = 10;  // free tier returns up to 10 per call

interface HunterEmail {
  value: string;
  type?: 'generic' | 'personal' | string;
  confidence?: number;
  position?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

interface HunterEnvelope {
  data?: {
    domain?: string;
    organization?: string | null;
    emails?: HunterEmail[];
  };
  errors?: Array<{ id?: string; code?: number; details?: string }>;
}

/**
 * Hunter returns an array of emails ranked by confidence. Pick the best one
 * for cold outreach: generic > personal (because cold-outreach to a generic
 * info@ is permitted by GDPR Recital 47, while personal addresses require
 * a real legitimate-interest justification). Among generics, prefer the
 * highest confidence.
 */
function pickBestHunterEmail(emails: HunterEmail[]): string | null {
  if (!emails || emails.length === 0) return null;
  const valid = emails.filter((e) => e?.value && e.value.includes('@'));
  if (valid.length === 0) return null;
  valid.sort((a, b) => {
    const ag = a.type === 'generic' ? 0 : 1;
    const bg = b.type === 'generic' ? 0 : 1;
    if (ag !== bg) return ag - bg;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
  return valid[0].value.toLowerCase();
}

function domainOf(websiteUrl: string): string | null {
  try {
    const u = new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export async function tier9HunterLookup(
  websiteUrl: string,
): Promise<{ email: string | null; organization?: string | null }> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return { email: null };

  const domain = domainOf(websiteUrl);
  if (!domain) return { email: null };

  const params = new URLSearchParams({
    domain,
    api_key: apiKey,
    limit: String(HUNTER_LIMIT),
  });
  const apiUrl = `${HUNTER_BASE}?${params.toString()}`;

  return new Promise<{ email: string | null; organization?: string | null }>((resolve) => {
    let resolved = false;
    const finish = (v: { email: string | null; organization?: string | null }) => {
      if (!resolved) { resolved = true; resolve(v); }
    };

    const req = https.get(apiUrl, { timeout: HUNTER_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        // Hunter encodes everything in JSON, including auth/quota errors.
        if (status === 401) {
          console.warn(`[tier9] Hunter returned 401 — check HUNTER_API_KEY validity`);
          return finish({ email: null });
        }
        if (status === 429) {
          console.warn(`[tier9] Hunter returned 429 — monthly free-tier quota exhausted`);
          return finish({ email: null });
        }
        try {
          const env = JSON.parse(body) as HunterEnvelope;
          if (env.errors && env.errors.length > 0) {
            const first = env.errors[0];
            console.warn(`[tier9] Hunter error: ${first.id ?? first.code ?? '?'} ${first.details ?? ''}`.trim());
            return finish({ email: null });
          }
          const email = pickBestHunterEmail(env.data?.emails ?? []);
          const organization = env.data?.organization ?? null;
          if (email) console.log(`[tier9] hit: ${email} (org=${organization ?? '?'})`);
          finish({ email, organization });
        } catch (err) {
          console.warn(`[tier9] Hunter parse error: ${(err as Error).message}`);
          finish({ email: null });
        }
      });
      res.on('error', () => finish({ email: null }));
    });
    req.on('timeout', () => { req.destroy(); finish({ email: null }); });
    req.on('error', (err) => {
      console.warn(`[tier9] Hunter request error: ${err.message}`);
      finish({ email: null });
    });
  });
}

export function hunterEnabled(): boolean {
  return !!process.env.HUNTER_API_KEY;
}

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

// ─── Cost discipline ───────────────────────────────────────────────────────
//
// Hunter's free tier is only 50 domain-searches per month, paid Starter is
// 500/mo at $34, so this tier needs aggressive guardrails to avoid burning
// the budget on no-value calls. Three layers:
//
//   1. Per-process domain cache — repeated leads from the same operator
//      (common in casino-affiliate clusters: 5 BPs all redirecting to
//      rocketplay30.com) only spend one credit. TTL 24h covers a typical
//      enrichment campaign without growing the cache unbounded.
//   2. Free/junk-domain skip — Hunter never has useful intel on gmail.com /
//      yahoo.com / generic webmail or on the project's own affiliate
//      tracker domains, so we don't pay to ask.
//   3. Per-process hourly cap (HUNTER_MAX_DOMAIN_SEARCHES_PER_HOUR,
//      default 15) — bounds bursts on a "verify all" click.
//
// All three are best-effort and process-local. Cloud Run multi-instance
// won't share the cache, but max-instances is small enough that the bound
// is still meaningful.

interface DomainSearchMemo {
  email: string | null;
  organization: string | null;
  ts: number;
}
const DOMAIN_TTL_MS = 24 * 60 * 60_000;
const _domainCache = new Map<string, DomainSearchMemo>();

const SKIP_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de',
  'hotmail.com', 'hotmail.co.uk',
  'outlook.com', 'outlook.fr', 'outlook.de',
  'live.com', 'icloud.com', 'me.com',
  'aol.com', 'mail.com', 'gmx.com', 'gmx.de', 'web.de',
  'protonmail.com', 'proton.me',
  'yandex.com', 'mail.ru',
]);

const MAX_CALLS_PER_HOUR = +(process.env.HUNTER_MAX_DOMAIN_SEARCHES_PER_HOUR ?? '15');
const _callTimestamps: number[] = [];
function withinHourlyBudget(): boolean {
  const cutoff = Date.now() - 60 * 60_000;
  while (_callTimestamps.length && _callTimestamps[0] < cutoff) _callTimestamps.shift();
  return _callTimestamps.length < MAX_CALLS_PER_HOUR;
}

export async function tier9HunterLookup(
  websiteUrl: string,
): Promise<{ email: string | null; organization?: string | null }> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return { email: null };

  const domain = domainOf(websiteUrl);
  if (!domain) return { email: null };

  // Cheap skips — never burn a credit on these.
  if (SKIP_DOMAINS.has(domain)) return { email: null };

  // Domain cache — second lead from the same operator returns the cached answer.
  const cached = _domainCache.get(domain);
  if (cached && Date.now() - cached.ts < DOMAIN_TTL_MS) {
    if (cached.email) console.log(`[tier9] cache hit: ${cached.email} for ${domain}`);
    return { email: cached.email, organization: cached.organization };
  }

  if (!withinHourlyBudget()) {
    console.warn(`[tier9] hourly cap (${MAX_CALLS_PER_HOUR}) hit — skipping ${domain}`);
    return { email: null };
  }
  _callTimestamps.push(Date.now());

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
          // Cache the result regardless of hit/miss — repeated leads from
          // the same operator domain shouldn't re-burn a credit just
          // because the first lookup was empty.
          _domainCache.set(domain, { email, organization, ts: Date.now() });
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

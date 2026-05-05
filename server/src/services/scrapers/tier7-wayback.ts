/**
 * Tier 7 — Wayback Machine archived-snapshot scan.
 *
 * Fallback for sites where the live page is gone, JS-only, or has scrubbed all
 * contact details. The Internet Archive caches static HTML snapshots going
 * back years; older versions of casino/affiliate sites very often had a plain
 * mailto: in the footer that's since been stripped. Free, no auth, no key.
 *
 * One CDX-API call per domain returns the list of archived URLs we have
 * snapshots for. We pick contact-relevant paths from that list, fetch the raw
 * archived HTML using the `id_/` flag (so the response is the original page
 * body, not Wayback's banner-injected wrapper), and grep for emails on the
 * registrable domain.
 *
 * Rate limiting: archive.org returns 429/503 if hit too fast from one IP. We
 * cap concurrent fetches at one per call (sequential within the function) and
 * abort early on the first hard rate-limit response.
 */

import https from 'node:https';
import http from 'node:http';

const CDX_TIMEOUT_MS = 8_000;
const SNAPSHOT_FETCH_TIMEOUT_MS = 7_000;
const MAX_SNAPSHOTS_TO_FETCH = 4;

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Path-suffix patterns we consider "contact-relevant" when filtering CDX rows.
// Tested case-insensitive against the URL path component.
const CONTACT_PATH_PATTERNS = [
  /\/contact(?:[\-_]us)?\/?$/i,
  /\/contacto\/?$/i,
  /\/kontakt\/?$/i,
  /\/contatti\/?$/i,
  /\/about(?:[\-_]us)?\/?$/i,
  /\/impressum\/?$/i,
  /\/imprint\/?$/i,
  /\/privacy(?:[\-_]policy)?\/?$/i,
  /\/legal\/?$/i,
  /^\/?$/,  // homepage
];

const REJECT_PREFIXES = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
  'postmaster', 'mailer-daemon', 'bounce', 'bounces', 'abuse',
  'spam', 'unsubscribe', 'webmaster',
]);

const TOP_PREFIXES = new Set([
  'contact', 'hello', 'hi', 'sales', 'partnerships', 'partner',
  'business', 'marketing', 'outreach', 'pr', 'media',
]);

const ACCEPTABLE_PREFIXES = new Set([
  'info', 'enquiries', 'enquiry', 'inquiries', 'inquiry',
  'office', 'team', 'mail', 'email', 'general', 'admin',
  'reception', 'help', 'support',
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

interface FetchResult {
  body: string | null;
  status: number;
}

function httpGet(rawUrl: string, timeoutMs: number, redirectsLeft = 3): Promise<FetchResult> {
  return new Promise((resolve) => {
    let url: URL;
    try { url = new URL(rawUrl); } catch { resolve({ body: null, status: 0 }); return; }
    const lib = url.protocol === 'http:' ? http : https;

    const req = lib.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OptiRateBot/1.0; +https://optiratesolutions.com)',
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        httpGet(next, timeoutMs, redirectsLeft - 1).then(resolve);
        return;
      }
      if (status !== 200) {
        res.resume();
        resolve({ body: null, status });
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf-8'), status }));
      res.on('error', () => resolve({ body: null, status }));
    });
    req.on('error', () => resolve({ body: null, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ body: null, status: 0 }); });
  });
}

function emailsForDomain(text: string, domain: string): string[] {
  if (!text) return [];
  const dom = domain.toLowerCase();
  const out: string[] = [];
  const matches = text.match(EMAIL_RE) || [];
  for (const m of matches) {
    const lower = m.toLowerCase();
    const at = lower.indexOf('@');
    if (at < 0) continue;
    const prefix = lower.slice(0, at);
    const emailDomain = lower.slice(at + 1);
    if (REJECT_PREFIXES.has(prefix)) continue;
    if (emailDomain !== dom && !emailDomain.endsWith('.' + dom)) continue;
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

function rankPrefix(email: string): number {
  const prefix = email.split('@')[0].toLowerCase();
  if (TOP_PREFIXES.has(prefix)) return 0;
  if (ACCEPTABLE_PREFIXES.has(prefix)) return 1;
  return 2;
}

function isContactRelevant(originalUrl: string): boolean {
  try {
    const path = new URL(originalUrl).pathname || '/';
    return CONTACT_PATH_PATTERNS.some((re) => re.test(path));
  } catch {
    return false;
  }
}

interface CdxRow {
  timestamp: string;
  original: string;
}

function parseCdxRows(body: string): CdxRow[] {
  try {
    const data = JSON.parse(body);
    if (!Array.isArray(data) || data.length < 2) return [];
    const header = data[0] as string[];
    const tsIdx = header.indexOf('timestamp');
    const origIdx = header.indexOf('original');
    if (tsIdx < 0 || origIdx < 0) return [];
    const rows: CdxRow[] = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (Array.isArray(row) && typeof row[tsIdx] === 'string' && typeof row[origIdx] === 'string') {
        rows.push({ timestamp: row[tsIdx], original: row[origIdx] });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

export interface Tier7Result {
  email: string | null;
  source?: string;
}

export async function tier7WaybackLookup(websiteUrl: string, deadline: number): Promise<Tier7Result> {
  const domain = extractDomain(websiteUrl);
  if (!domain) return { email: null };

  // One CDX call returns every archived URL for the domain. We then filter to
  // contact-relevant paths, dedup by path keeping the most recent snapshot,
  // and fetch up to MAX_SNAPSHOTS_TO_FETCH.
  const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain + '/*')}` +
    `&output=json&filter=statuscode:200&filter=mimetype:text/html&limit=200`;
  const cdxRes = await httpGet(cdxUrl, CDX_TIMEOUT_MS);
  if (cdxRes.status === 429 || cdxRes.status === 503) {
    console.log(`    [tier7] wayback rate-limited (${cdxRes.status}) for ${domain}`);
    return { email: null };
  }
  if (!cdxRes.body) {
    console.log(`    [tier7] no cdx response for ${domain}`);
    return { email: null };
  }

  const rows = parseCdxRows(cdxRes.body);
  if (rows.length === 0) {
    console.log(`    [tier7] no wayback snapshots for ${domain}`);
    return { email: null };
  }

  // Filter to contact-relevant paths, keep the most recent snapshot per path.
  const byPath = new Map<string, CdxRow>();
  for (const row of rows) {
    if (!isContactRelevant(row.original)) continue;
    let pathKey = '/';
    try { pathKey = new URL(row.original).pathname.replace(/\/$/, '') || '/'; } catch { continue; }
    const existing = byPath.get(pathKey);
    if (!existing || row.timestamp > existing.timestamp) {
      byPath.set(pathKey, row);
    }
  }

  // Order: prefer /contact* paths first, then /about*, then homepage, then others.
  const ordered = [...byPath.values()].sort((a, b) => {
    const score = (r: CdxRow) => {
      const p = (() => { try { return new URL(r.original).pathname.toLowerCase(); } catch { return ''; } })();
      if (/contact|kontakt|contacto|contatti/.test(p)) return 0;
      if (/about|impressum|imprint/.test(p)) return 1;
      if (p === '/' || p === '') return 2;
      return 3;
    };
    return score(a) - score(b);
  }).slice(0, MAX_SNAPSHOTS_TO_FETCH);

  if (ordered.length === 0) {
    console.log(`    [tier7] no contact-relevant snapshots for ${domain} (had ${rows.length} total)`);
    return { email: null };
  }

  const candidates: { email: string; path: string }[] = [];

  for (const row of ordered) {
    if (Date.now() >= deadline) break;
    const snapUrl = `https://web.archive.org/web/${row.timestamp}id_/${row.original}`;
    const snap = await httpGet(snapUrl, SNAPSHOT_FETCH_TIMEOUT_MS);
    if (snap.status === 429 || snap.status === 503) {
      console.log(`    [tier7] snapshot rate-limited (${snap.status}) — aborting`);
      break;
    }
    if (!snap.body) continue;

    const path = (() => { try { return new URL(row.original).pathname || '/'; } catch { return '/'; } })();
    for (const em of emailsForDomain(snap.body, domain)) {
      if (!candidates.some((c) => c.email === em)) {
        candidates.push({ email: em, path });
      }
    }
    // Stop early if we found a top-tier outreach prefix
    if (candidates.some((c) => rankPrefix(c.email) === 0)) break;
  }

  if (candidates.length === 0) {
    console.log(`    [tier7] no wayback emails for ${domain}`);
    return { email: null };
  }

  candidates.sort((a, b) => rankPrefix(a.email) - rankPrefix(b.email) || a.email.length - b.email.length);
  const best = candidates[0];
  console.log(`    [tier7] hit for ${domain}: ${best.email} (wayback ${best.path})`);
  return { email: best.email, source: `wayback ${best.path}` };
}

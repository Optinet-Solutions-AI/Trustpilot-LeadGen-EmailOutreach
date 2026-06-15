// Pure parser for the bulk-add-affiliates feature. Turns pasted Trustpilot
// review URLs into affiliate rows. Dependency-free on purpose: the canonical
// tp_url is re-sanitized idempotently by url-validator at validation time, so
// this module owns only the cheap parse + dedupe and stays trivially testable.

export interface ParsedAffiliate {
  name: string;
  website: string;
  tp_url: string;
  geo: string[];
  warning: false;
}

interface ExistingAffiliate {
  website: string | null;
  // Dedup is by normalized website only; tp_url is accepted (the route selects
  // it) but not currently used for matching. Kept so callers can pass DB rows
  // verbatim without reshaping.
  tp_url: string | null;
}

export interface BulkPartition {
  toInsert: ParsedAffiliate[];
  skipped: string[]; // websites already tracked (in DB or earlier in the paste)
  invalid: string[]; // lines that are not parseable Trustpilot review URLs
}

const REVIEW_PATH = /\/review\/([^/?#]+)/i;
const HOST_IS_TRUSTPILOT = /(^|\.)trustpilot\.com$/;
const REGIONAL_SUBDOMAIN = /^([a-z]{2})\.trustpilot\.com$/;

function normalizeWebsite(raw: string): string {
  return raw.toLowerCase().replace(/^www\./, '');
}

export function parseTrustpilotAffiliateUrl(line: string): ParsedAffiliate | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let candidate = trimmed.replace(/^["'<]+|["'>]+$/g, '');
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate.replace(/^\/+/, '');

  let u: URL;
  try { u = new URL(candidate); } catch { return null; }

  const host = u.host.toLowerCase();
  if (!HOST_IS_TRUSTPILOT.test(host)) return null;

  const m = u.pathname.match(REVIEW_PATH);
  if (!m) return null;

  const slug = m[1].toLowerCase();
  const website = normalizeWebsite(slug);
  if (!website) return null;

  const tp_url = `https://${host}/review/${slug}`;

  // Any 2-letter subdomain becomes the geo. Trustpilot only uses ISO-3166-1
  // alpha-2 country subdomains (de., au., dk., it., …), so this is safe for the
  // real URL corpus; www./bare hosts have no 2-letter match and yield [].
  const sub = host.match(REGIONAL_SUBDOMAIN);
  const geo = sub ? [sub[1].toUpperCase()] : [];

  const label = website.split('.')[0].replace(/[-_]+/g, ' ').trim();
  const name = label ? label.charAt(0).toUpperCase() + label.slice(1) : website;

  return { name, website, tp_url, geo, warning: false };
}

export function partitionBulkUrls(text: string, existing: ExistingAffiliate[]): BulkPartition {
  const existingSites = new Set(
    existing.map((e) => normalizeWebsite(e.website ?? '')).filter(Boolean),
  );
  const seen = new Set<string>();
  const toInsert: ParsedAffiliate[] = [];
  const skipped: string[] = [];
  const invalid: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseTrustpilotAffiliateUrl(line);
    if (!parsed) { invalid.push(line.trim()); continue; }
    if (existingSites.has(parsed.website) || seen.has(parsed.website)) {
      skipped.push(parsed.website);
      continue;
    }
    seen.add(parsed.website);
    toInsert.push(parsed);
  }

  return { toInsert, skipped, invalid };
}

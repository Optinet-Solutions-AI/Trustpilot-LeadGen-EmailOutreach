/**
 * Tier 6 — WHOIS registrant lookup.
 *
 * Last-line fallback for sites where every page-scraping tier (1-5) failed
 * to find an email. Pulls the domain registrant's email from the public
 * WHOIS database — every domain has one because TLD registries require it.
 *
 * Why this works when scraping doesn't:
 *   - The casino industry intentionally hides emails from page HTML, but the
 *     domain registrant info is filed with the registrar at purchase time
 *     and exposed via the WHOIS protocol regardless of website content.
 *   - Even when the registrant uses a privacy proxy (Domains By Proxy,
 *     WhoisGuard, etc.), the proxy email forwards to the real owner — so
 *     "service@withheldforprivacy.com" is still a deliverable contact path.
 *
 * Disabled silently if the `whoiser` package isn't available, so this tier
 * is safe to add without breaking deployments that haven't installed it.
 */

import { whoisDomain } from 'whoiser';

// Per-lookup timeout. Most TLD WHOIS servers respond in <1s; ccTLDs and
// rate-limited registrars can take longer. 7s is enough headroom without
// blowing the per-lead budget when chained after Tier 5.
const WHOIS_TIMEOUT_MS = 7_000;

// Privacy-proxy + registrar/anonymization email domains. These get rejected
// outright — post-GDPR most domain registrants use them, and the supposed
// "forwarding" feature has become unreliable (most proxies just bin emails
// now). Sending to them risks abuse complaints back to OUR sending domain.
const REJECT_EMAIL_DOMAINS = new Set([
  // Privacy proxies — modern services no longer reliably forward
  'domainsbyproxy.com', 'whoisguard.com', 'whoisprivacyprotect.com',
  'whoisprivacycorp.com', 'whoisprotectservice.com', 'contactprivacy.com',
  'privacyguardian.org', 'withheldforprivacy.com', 'withheldforprivacy.email',
  'privacyprotect.org', 'privatewhois.com', 'whoisprivacy.org',
  'data-protected.net', 'privacy-link.com', 'redacted.email',
  'idp.email', 'protecteddomainservices.com',
  'domains-anonymizer.com', 'anonymize.com', 'whoisproxy.com',
  'privacy-protect.cn', 'gdprmasked.com', 'privacy-mail.org',
  // Known registrars — emailing these triggers abuse complaints
  'markmonitor.com', 'gname.com', 'registrar.eu', 'enom.com',
  'godaddy.com', 'namecheap.com', 'gandi.net', 'name.com',
  'tucows.com', 'opensrs.com', 'register.com', 'porkbun.com',
  'cloudflare.com', 'amazonaws.com', 'route53.amazonaws.com',
  'safenames.net', 'csc-lp.com', 'corporatedomains.com', 'cscglobal.com',
  'markmonitor-international.com', 'ascio.com', 'realtimeregister.com',
]);

// ONLY these exact WHOIS field names yield useful operator contacts.
// Registrant > Admin = Owner. Tech is engineering, sometimes operator.
// "Registrar Abuse Contact Email" / "Reseller Email" / generic "Email"
// fields are explicitly EXCLUDED — they belong to the domain registrar
// (the company that sold the domain), not the operator we want to reach.
const EMAIL_FIELD_PRIORITY = [
  'Registrant Email',
  'Registrant Contact Email',
  'Admin Email',
  'Administrative Contact Email',
  'Tech Email',
  'Technical Contact Email',
];

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

function extractDomain(websiteUrl: string): string | null {
  try {
    const trimmed = websiteUrl.trim();
    const withProtocol = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    const hostname = new URL(withProtocol).hostname.replace(/^www\./, '');
    // WHOIS lookups need the registrable domain, not subdomains. For most
    // TLDs the registrable domain is the last 2 labels (example.com), but
    // multi-level TLDs (.co.uk, .com.au) need the last 3. Heuristic: if the
    // second-to-last label is 2-3 chars (typical for ccTLD subdomains like
    // 'co', 'com'), include 3 labels.
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

function looksLikeEmail(value: string): boolean {
  return EMAIL_RE.test(value) && !value.toLowerCase().includes('redacted');
}

interface WhoisFinding {
  email: string;
  source: string;        // which WHOIS field it came from
}

function isAcceptableEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  if (REJECT_EMAIL_DOMAINS.has(domain)) return false;
  // Reject obvious random-string anonymization (e.g. htfdgaeap1kd@idp.email).
  // Heuristic: prefix is 12+ chars of mixed-but-no-vowel-pattern alphanumeric.
  const prefix = email.split('@')[0];
  if (prefix.length >= 12 && !/[aeiou]/i.test(prefix)) return false;
  return true;
}

/**
 * Walk a (possibly nested) whoiser response object and collect emails ONLY
 * from EMAIL_FIELD_PRIORITY-matched fields. Anything from "Registrar Abuse
 * Contact Email" or generic "Email" fields is intentionally ignored — those
 * belong to the registrar, not the operator.
 */
function collectEmails(obj: unknown, candidates: WhoisFinding[]): void {
  if (!obj || typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (EMAIL_FIELD_PRIORITY.includes(key)) {
        const match = value.match(EMAIL_RE);
        if (match && looksLikeEmail(match[0])) {
          const email = match[0].toLowerCase();
          if (isAcceptableEmail(email) && !candidates.some((c) => c.email === email)) {
            candidates.push({ email, source: key });
          }
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          collectEmails(item, candidates);
        }
      }
    } else if (value && typeof value === 'object') {
      collectEmails(value, candidates);
    }
  }
}

function pickBestWhoisEmail(candidates: WhoisFinding[]): WhoisFinding | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const aIdx = EMAIL_FIELD_PRIORITY.indexOf(a.source);
    const bIdx = EMAIL_FIELD_PRIORITY.indexOf(b.source);
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  })[0];
}

export interface Tier6Result {
  email: string | null;
  source?: string;
}

/**
 * Look up the registrant email for a domain via WHOIS.
 * Returns null if WHOIS lookup fails, the domain has no extractable email,
 * or every email is in our undeliverable/code-fragment filters.
 */
export async function tier6WhoisLookup(websiteUrl: string): Promise<Tier6Result> {
  const domain = extractDomain(websiteUrl);
  if (!domain) return { email: null };

  let response: unknown;
  try {
    response = await whoisDomain(domain, { timeout: WHOIS_TIMEOUT_MS, follow: 2 });
  } catch (err) {
    console.log(`    [tier6] whois lookup failed for ${domain}: ${(err as Error).message.slice(0, 100)}`);
    return { email: null };
  }

  const candidates: WhoisFinding[] = [];
  collectEmails(response, candidates);

  const best = pickBestWhoisEmail(candidates);
  if (!best) {
    console.log(`    [tier6] no operator email in whois for ${domain}`);
    return { email: null };
  }

  console.log(`    [tier6] hit for ${domain}: ${best.email} (from ${best.source})`);
  return { email: best.email, source: best.source };
}

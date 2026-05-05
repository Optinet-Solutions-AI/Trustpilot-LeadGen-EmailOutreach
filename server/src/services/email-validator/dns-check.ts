// Stage 2 — Domain DNS check.
//
// Resolves MX records (priority-sorted) and classifies the provider so the
// downstream SMTP probe can decide whether the host will give an honest
// RCPT-TO answer (cPanel, Bluehost, Zoho) or always lie (Gmail, Outlook365).
//
// Per RFC 5321 §5.1, when a domain has no MX record but does have an A record,
// the A record is treated as an implicit MX of preference 0 — meaning mail
// SHOULD be delivered to that host. We honour this fallback so domains running
// their own mail server on the same machine as their web server (common for
// small businesses on shared hosting) aren't wrongly marked invalid.
//
// One important exception: when the A record points to a CDN/edge proxy
// (Cloudflare, Akamai, Fastly, etc.), those services don't expose SMTP on
// port 25, so mail delivery fails regardless of A-record fallback. Those
// domains stay flagged invalid with a clearer reason.
//
// Uses explicit public DNS servers because Cloud Run's default resolver has
// historically been flaky on cold-start MX queries.

import { Resolver } from 'node:dns/promises';
import { isDisposableDomain } from './disposable-domains.js';

const resolver = new Resolver();
resolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

export type ProviderType = 'google_workspace' | 'outlook365' | 'cpanel_or_other';

export interface DnsCheckResult {
  hasMx: boolean;
  mxTop: string | null;        // top-priority MX hostname (lowest priority number)
  providerType: ProviderType | null;
  isDisposable: boolean;
  reason?: string;
  // Diagnostic flags — surfaced in notes/UI tooltip
  mxSource?: 'mx' | 'a_implicit';   // whether mxTop came from MX records or A-record fallback
  aOnlyCdn?: boolean;               // true when only A records exist and they all point to a CDN
}

const GOOGLE_MX_SUFFIXES = ['google.com.', 'googlemail.com.', 'aspmx.l.google.com.', 'googlemail.com'];
const OUTLOOK_MX_SUFFIXES = ['outlook.com.', 'protection.outlook.com.', 'mail.protection.outlook.com.'];

// Known CDN / edge-proxy IP ranges that don't expose SMTP on port 25.
// When a domain's only mail-routing path is an A record landing on one of
// these, mail delivery is structurally impossible and the address is invalid
// regardless of mailbox existence. List is intentionally conservative — only
// ranges where it's definitively true that SMTP isn't proxied.
const CDN_IP_RANGES: Array<{ name: string; cidr: string }> = [
  // Cloudflare IPv4 (https://www.cloudflare.com/ips-v4)
  { name: 'cloudflare', cidr: '173.245.48.0/20' },
  { name: 'cloudflare', cidr: '103.21.244.0/22' },
  { name: 'cloudflare', cidr: '103.22.200.0/22' },
  { name: 'cloudflare', cidr: '103.31.4.0/22' },
  { name: 'cloudflare', cidr: '141.101.64.0/18' },
  { name: 'cloudflare', cidr: '108.162.192.0/18' },
  { name: 'cloudflare', cidr: '190.93.240.0/20' },
  { name: 'cloudflare', cidr: '188.114.96.0/20' },
  { name: 'cloudflare', cidr: '197.234.240.0/22' },
  { name: 'cloudflare', cidr: '198.41.128.0/17' },
  { name: 'cloudflare', cidr: '162.158.0.0/15' },
  { name: 'cloudflare', cidr: '104.16.0.0/13' },
  { name: 'cloudflare', cidr: '104.24.0.0/14' },
  { name: 'cloudflare', cidr: '172.64.0.0/13' },
  { name: 'cloudflare', cidr: '131.0.72.0/22' },
  // Fastly (https://api.fastly.com/public-ip-list)
  { name: 'fastly', cidr: '23.235.32.0/20' },
  { name: 'fastly', cidr: '43.249.72.0/22' },
  { name: 'fastly', cidr: '103.244.50.0/24' },
  { name: 'fastly', cidr: '103.245.222.0/23' },
  { name: 'fastly', cidr: '103.245.224.0/24' },
  { name: 'fastly', cidr: '104.156.80.0/20' },
  { name: 'fastly', cidr: '146.75.0.0/17' },
  { name: 'fastly', cidr: '151.101.0.0/16' },
  { name: 'fastly', cidr: '157.52.64.0/18' },
  { name: 'fastly', cidr: '167.82.0.0/17' },
  { name: 'fastly', cidr: '167.82.128.0/20' },
  { name: 'fastly', cidr: '167.82.160.0/20' },
  { name: 'fastly', cidr: '167.82.224.0/20' },
  { name: 'fastly', cidr: '172.111.64.0/18' },
  { name: 'fastly', cidr: '185.31.16.0/22' },
  { name: 'fastly', cidr: '199.27.72.0/21' },
  { name: 'fastly', cidr: '199.232.0.0/16' },
];

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) >>> 0;
    n = (n + o) >>> 0;
  }
  return n >>> 0;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split('/');
  const ipInt = ipToInt(ip);
  const baseInt = ipToInt(base);
  const prefix = Number(prefixStr);
  if (ipInt === null || baseInt === null || !Number.isInteger(prefix)) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

function classifyCdn(ip: string): string | null {
  for (const range of CDN_IP_RANGES) {
    if (ipInCidr(ip, range.cidr)) return range.name;
  }
  return null;
}

function classifyProvider(mxHostname: string): ProviderType {
  const h = mxHostname.toLowerCase();
  if (GOOGLE_MX_SUFFIXES.some((s) => h.endsWith(s) || h.includes('aspmx.l.google.com'))) {
    return 'google_workspace';
  }
  if (OUTLOOK_MX_SUFFIXES.some((s) => h.endsWith(s) || h.includes('mail.protection.outlook.com'))) {
    return 'outlook365';
  }
  return 'cpanel_or_other';
}

export async function checkDns(email: string): Promise<DnsCheckResult> {
  const domain = email.split('@')[1]?.toLowerCase() || '';
  if (!domain) {
    return { hasMx: false, mxTop: null, providerType: null, isDisposable: false, reason: 'No domain' };
  }

  if (isDisposableDomain(domain)) {
    return {
      hasMx: false,
      mxTop: null,
      providerType: null,
      isDisposable: true,
      reason: `Disposable domain "${domain}"`,
    };
  }

  // ── Primary: MX lookup ──────────────────────────────────────────────────
  let mxRecords: Array<{ priority: number; exchange: string }> = [];
  let mxErrCode: string | null = null;
  try {
    mxRecords = await resolver.resolveMx(domain);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    mxErrCode = e.code || null;
    // ENOTFOUND = domain doesn't exist at all → terminal. ENODATA = domain
    // exists, just no MX records → fall through to A-record check.
    if (e.code === 'ENOTFOUND') {
      return { hasMx: false, mxTop: null, providerType: null, isDisposable: false, reason: `Domain "${domain}" does not exist` };
    }
    // For any other error (SERVFAIL, network issue, etc.) we also fall
    // through to the A-record check below — better to attempt fallback than
    // wrongly mark as invalid on a transient resolver hiccup.
  }

  if (mxRecords.length > 0) {
    mxRecords.sort((a, b) => a.priority - b.priority);
    const mxTop = mxRecords[0].exchange.toLowerCase().replace(/\.$/, '');
    return {
      hasMx: true,
      mxTop,
      providerType: classifyProvider(mxRecords[0].exchange),
      isDisposable: false,
      mxSource: 'mx',
    };
  }

  // ── Fallback: A-record as implicit MX (RFC 5321 §5.1) ───────────────────
  let aRecords: string[] = [];
  try {
    aRecords = await resolver.resolve4(domain);
  } catch {
    aRecords = [];
  }

  if (aRecords.length === 0) {
    return {
      hasMx: false,
      mxTop: null,
      providerType: null,
      isDisposable: false,
      reason: mxErrCode
        ? `Domain has no MX or A records (${mxErrCode})`
        : 'Domain has no MX or A records',
    };
  }

  // If every A record lands on a known CDN/edge proxy, mail delivery is
  // structurally impossible — those services don't run SMTP on port 25.
  const cdnNames = aRecords.map(classifyCdn).filter((n): n is string => n !== null);
  if (cdnNames.length === aRecords.length) {
    const cdn = cdnNames[0];
    return {
      hasMx: false,
      mxTop: null,
      providerType: null,
      isDisposable: false,
      aOnlyCdn: true,
      reason: `Domain has no MX record and is fronted by ${cdn} — no SMTP infrastructure exists for this domain`,
    };
  }

  // Plausible A-record fallback: treat the domain itself as the implicit MX.
  // Downstream SMTP probe will tell us whether port 25 actually responds.
  return {
    hasMx: true,
    mxTop: domain,
    providerType: 'cpanel_or_other',
    isDisposable: false,
    mxSource: 'a_implicit',
  };
}

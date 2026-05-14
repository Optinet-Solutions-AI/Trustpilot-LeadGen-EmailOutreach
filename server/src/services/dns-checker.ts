/**
 * DNS readiness checker — verifies MX, SPF, and DMARC records for a domain.
 * Uses Node's built-in dns/promises module — no external dependency.
 */

import { promises as dns } from 'dns';

// ─── Public types ────────────────────────────────────────────────────────────

/** Slim shape consumed by email-accounts (per-account DNS badge). */
export interface DnsCheckResult {
  mx: boolean;
  spf: boolean;
  dmarc: boolean;
}

export type MxProvider =
  | 'Google Workspace'
  | 'Microsoft 365 / Outlook'
  | 'Zoho Mail'
  | 'ProtonMail'
  | 'iCloud Mail'
  | 'Fastmail'
  | 'Yahoo Mail'
  | 'Titan (Bluehost)'
  | 'Amazon SES'
  | 'SendGrid'
  | 'Mailgun'
  | 'Postmark'
  | 'MXroute'
  | 'DreamHost (MailChannels)'
  | 'cPanel / Shared Host'
  | 'Self-hosted / Unknown';

export interface MxCheck {
  ok: boolean;
  provider: MxProvider;
  trusted: boolean;
  hosts: string[];
  error?: string;
}

export interface SpfCheck {
  ok: boolean;
  record: string | null;
  error?: string;
}

export interface DmarcCheck {
  ok: boolean;
  record: string | null;
  policy: 'none' | 'quarantine' | 'reject' | null;
  error?: string;
}

export interface DomainHealth {
  domain: string;
  healthy: boolean;
  mx: MxCheck;
  spf: SpfCheck;
  dmarc: DmarcCheck;
  checkedAt: string;
}

// ─── MX provider classification ──────────────────────────────────────────────

const PROVIDER_PATTERNS: Array<{ test: RegExp; provider: MxProvider; trusted: boolean }> = [
  { test: /(aspmx|googlemail|google)\.l\.google\.com$/i,                    provider: 'Google Workspace',            trusted: true  },
  { test: /\.google\.com$/i,                                                provider: 'Google Workspace',            trusted: true  },
  { test: /\.(outlook|protection\.outlook|mail\.protection\.outlook)\.com$/i, provider: 'Microsoft 365 / Outlook',  trusted: true  },
  { test: /\.zoho(?:mail)?\.(com|eu|in)$/i,                                 provider: 'Zoho Mail',                   trusted: true  },
  { test: /\.protonmail\.(ch|com)$/i,                                       provider: 'ProtonMail',                  trusted: true  },
  { test: /\.icloud\.com$/i,                                                provider: 'iCloud Mail',                 trusted: true  },
  { test: /\.(messagingengine|fastmail)\.com$/i,                            provider: 'Fastmail',                    trusted: true  },
  { test: /\.yahoodns\.net$/i,                                              provider: 'Yahoo Mail',                  trusted: true  },
  { test: /\.titan\.email$/i,                                               provider: 'Titan (Bluehost)',            trusted: true  },
  { test: /\.amazonses\.com$/i,                                             provider: 'Amazon SES',                  trusted: true  },
  { test: /\.sendgrid\.net$/i,                                              provider: 'SendGrid',                    trusted: true  },
  { test: /\.mailgun\.org$/i,                                               provider: 'Mailgun',                     trusted: true  },
  { test: /\.postmarkapp\.com$/i,                                           provider: 'Postmark',                    trusted: true  },
  { test: /\.mxrouting\.net$/i,                                             provider: 'MXroute',                     trusted: true  },
  { test: /\.mailchannels\.net$/i,                                          provider: 'DreamHost (MailChannels)',    trusted: false },
  { test: /\.(mailhost|hostgator|bluehost|dreamhost|hostmonster)\.(com|net)$/i, provider: 'cPanel / Shared Host',  trusted: false },
];

function classifyMxProvider(hosts: string[]): { provider: MxProvider; trusted: boolean } {
  for (const host of hosts) {
    for (const { test, provider, trusted } of PROVIDER_PATTERNS) {
      if (test.test(host)) return { provider, trusted };
    }
  }
  return { provider: 'Self-hosted / Unknown', trusted: false };
}

// ─── Individual checks ───────────────────────────────────────────────────────

async function checkMxRecord(domain: string): Promise<MxCheck> {
  try {
    const records = await dns.resolveMx(domain);
    if (!records.length) {
      return { ok: false, provider: 'Self-hosted / Unknown', trusted: false, hosts: [],
        error: 'No MX records found — domain cannot receive mail and will fail SPF alignment.' };
    }
    const hosts = records
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''));
    const { provider, trusted } = classifyMxProvider(hosts);
    return { ok: true, provider, trusted, hosts };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const error =
      code === 'ENOTFOUND' || code === 'ENODATA'
        ? 'No MX records found — domain cannot receive mail.'
        : `MX lookup failed (${code ?? 'unknown'}).`;
    return { ok: false, provider: 'Self-hosted / Unknown', trusted: false, hosts: [], error };
  }
}

async function checkSpfRecord(domain: string): Promise<SpfCheck> {
  try {
    const records = await dns.resolveTxt(domain);
    const flat = records.map((r) => r.join(''));
    const spf = flat.find((r) => r.toLowerCase().startsWith('v=spf1'));
    if (!spf) {
      return { ok: false, record: null,
        error: 'No SPF record found. Add a TXT record like "v=spf1 include:_spf.google.com ~all" on the root domain.' };
    }
    return { ok: true, record: spf };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, record: null,
      error: code === 'ENOTFOUND' || code === 'ENODATA'
        ? 'No TXT records found on root domain — SPF is missing.'
        : `SPF lookup failed (${code ?? 'unknown'}).` };
  }
}

async function checkDmarcRecord(domain: string): Promise<DmarcCheck> {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    const flat = records.map((r) => r.join(''));
    const dmarc = flat.find((r) => r.toLowerCase().startsWith('v=dmarc1'));
    if (!dmarc) {
      return { ok: false, record: null, policy: null,
        error: 'No DMARC record found. Add a TXT record on _dmarc.' + domain + ' like "v=DMARC1; p=none; rua=mailto:reports@' + domain + '"' };
    }
    const policyMatch = dmarc.match(/[;\s]p=([a-z]+)/i);
    const policyRaw = policyMatch?.[1]?.toLowerCase() ?? null;
    const policy: DmarcCheck['policy'] =
      policyRaw === 'none' || policyRaw === 'quarantine' || policyRaw === 'reject' ? policyRaw : null;
    return { ok: true, record: dmarc, policy };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, record: null, policy: null,
      error: code === 'ENOTFOUND' || code === 'ENODATA'
        ? `No DMARC record at _dmarc.${domain}. Cold mail without DMARC is heavily filtered by Gmail/Yahoo.`
        : `DMARC lookup failed (${code ?? 'unknown'}).` };
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Rich health report — used by GET /api/dns-health/:domain and pre-send gates. */
export async function checkDomainHealth(domain: string): Promise<DomainHealth> {
  const normalized = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const [mx, spf, dmarc] = await Promise.all([
    checkMxRecord(normalized),
    checkSpfRecord(normalized),
    checkDmarcRecord(normalized),
  ]);
  return {
    domain: normalized,
    healthy: mx.ok && spf.ok && dmarc.ok,
    mx,
    spf,
    dmarc,
    checkedAt: new Date().toISOString(),
  };
}

/** Boolean-only shape kept for email-accounts.ts and the per-account DNS badge. */
export async function verifyDomainDNS(domain: string): Promise<DnsCheckResult> {
  const health = await checkDomainHealth(domain);
  return { mx: health.mx.ok, spf: health.spf.ok, dmarc: health.dmarc.ok };
}

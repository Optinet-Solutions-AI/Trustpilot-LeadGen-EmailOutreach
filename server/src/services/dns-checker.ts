/**
 * DNS readiness checker — verifies MX, SPF, DMARC, and DKIM records for a domain.
 * Uses Node's built-in dns/promises module — no external dependency.
 */

import { promises as dns } from 'dns';

// ─── Public types ────────────────────────────────────────────────────────────

/** Slim shape consumed by email-accounts (per-account DNS badge). */
export interface DnsCheckResult {
  mx: boolean;
  spf: boolean;
  dmarc: boolean;
  dkim: boolean;
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

export interface DkimCheck {
  ok: boolean;
  selector: string | null;
  record: string | null;
  triedSelectors: string[];
  error?: string;
}

export interface DomainHealth {
  domain: string;
  healthy: boolean;
  mx: MxCheck;
  spf: SpfCheck;
  dmarc: DmarcCheck;
  dkim: DkimCheck;
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

// ─── DKIM selector discovery ─────────────────────────────────────────────────

/**
 * Common DKIM selectors keyed by MX provider. We probe these in parallel —
 * any one that returns a TXT record matching DKIM syntax (v=DKIM1 or p=…) is
 * a pass. The "generic" list is also tried as a fallback so self-hosted /
 * unknown setups with a standard selector (default, mail, email) are still
 * detected.
 *
 * Adding more providers? Drop a selector list in here, keyed by the MxProvider
 * string. Order matters only for the `triedSelectors` array in the response.
 */
const DKIM_SELECTORS_BY_PROVIDER: Partial<Record<MxProvider, string[]>> = {
  'Google Workspace':           ['google'],
  'Microsoft 365 / Outlook':    ['selector1', 'selector2'],
  'Zoho Mail':                  ['zoho', 'zmail', 's1'],
  'ProtonMail':                 ['protonmail', 'protonmail2', 'protonmail3'],
  'iCloud Mail':                ['sig1'],
  'Fastmail':                   ['fm1', 'fm2', 'fm3', 'mesmtp'],
  'Yahoo Mail':                 ['s2048', 's1024'],
  'Titan (Bluehost)':           ['titan1', 'titan2'],
  'Amazon SES':                 [],                            // customer-specific tokens; nothing to probe
  'SendGrid':                   ['s1', 's2'],
  'Mailgun':                    ['mailo', 'k1', 'mg'],
  'Postmark':                   ['pm', 'postmark'],
  'MXroute':                    ['x'],
  'DreamHost (MailChannels)':   ['dreamhost', 'mailchannels'],
  'cPanel / Shared Host':       ['default'],
};

const GENERIC_DKIM_SELECTORS = ['default', 'mail', 'email', 'selector1', 'k1', 's1'];

const DKIM_RE = /^(v=dkim1\b|.*\bk=rsa\b|.*\bp=)/i;

async function probeSelector(selector: string, domain: string): Promise<{ selector: string; record: string } | null> {
  try {
    const records = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
    const flat = records.map((r) => r.join('')).join(' ');
    if (DKIM_RE.test(flat)) return { selector, record: flat };
    return null;
  } catch {
    return null;
  }
}

async function checkDkimRecord(domain: string, provider: MxProvider): Promise<DkimCheck> {
  const providerSelectors = DKIM_SELECTORS_BY_PROVIDER[provider] ?? [];
  // De-duplicate while preserving order. Provider-specific selectors first.
  const seen = new Set<string>();
  const triedSelectors: string[] = [];
  for (const s of [...providerSelectors, ...GENERIC_DKIM_SELECTORS]) {
    if (!seen.has(s)) { seen.add(s); triedSelectors.push(s); }
  }

  if (triedSelectors.length === 0) {
    return {
      ok: false, selector: null, record: null, triedSelectors,
      error: `No known DKIM selectors for provider "${provider}". Look up the DKIM record in your provider's admin panel and confirm it's published.`,
    };
  }

  const results = await Promise.all(triedSelectors.map((s) => probeSelector(s, domain)));
  const hit = results.find((r) => r !== null);

  if (hit) return { ok: true, selector: hit.selector, record: hit.record, triedSelectors };

  const providerHint =
    provider === 'Titan (Bluehost)'         ? 'In Bluehost → Email Accounts → DKIM, copy the TXT record (host: titan1._domainkey).' :
    provider === 'Google Workspace'         ? 'In Google Admin → Apps → Gmail → Authenticate email, generate a DKIM key and publish the TXT (host: google._domainkey).' :
    provider === 'Microsoft 365 / Outlook'  ? 'In Microsoft 365 Defender → Email & Collaboration → Email Authentication → DKIM, enable signing and publish selector1/selector2 CNAMEs.' :
    provider === 'Zoho Mail'                ? 'In Zoho Mail Admin → Domains → DKIM, copy the zoho._domainkey TXT and publish it.' :
    provider === 'DreamHost (MailChannels)' ? 'In DreamHost panel → Mail → DKIM, enable signing and publish the dreamhost._domainkey TXT.' :
    provider === 'cPanel / Shared Host'     ? 'In cPanel → Email Deliverability, install the default._domainkey record.' :
    'Look up the DKIM record in your email provider\'s admin panel and publish it as a TXT record.';

  return {
    ok: false, selector: null, record: null, triedSelectors,
    error: `No DKIM record found on any known selector (${triedSelectors.map(s => `${s}._domainkey.${domain}`).join(', ')}). ${providerHint}`,
  };
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
  // DKIM probing depends on the MX provider classification.
  const dkim = await checkDkimRecord(normalized, mx.provider);
  return {
    domain: normalized,
    healthy: mx.ok && spf.ok && dmarc.ok && dkim.ok,
    mx,
    spf,
    dmarc,
    dkim,
    checkedAt: new Date().toISOString(),
  };
}

/** Boolean-only shape kept for email-accounts.ts and the per-account DNS badge. */
export async function verifyDomainDNS(domain: string): Promise<DnsCheckResult> {
  const health = await checkDomainHealth(domain);
  return { mx: health.mx.ok, spf: health.spf.ok, dmarc: health.dmarc.ok, dkim: health.dkim.ok };
}

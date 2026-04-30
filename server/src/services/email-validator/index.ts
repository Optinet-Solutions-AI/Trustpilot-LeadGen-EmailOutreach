// Layered email validator — orchestrates all stages and applies the strict
// verdict ladder.
//
// The "no guessing" rule:
//   - `valid` requires positive proof (RCPT-TO 250 on a non-catch-all domain,
//     or ZeroBounce returning valid).
//   - Catch-all domains are labelled `catch-all`, never `valid`.
//   - Anything inconclusive is `unknown` — never silently upgraded to valid.

import { checkSyntax } from './syntax-check.js';
import { checkDns, type ProviderType } from './dns-check.js';
import { rcptProbe } from './smtp-probe.js';
import { probeCatchAll } from './catch-all-probe.js';
import { getCachedDomainIntel, upsertDomainIntel } from './domain-intel.js';
import { verifyEmails as verifyEmailsZB } from '../email-verifier.zerobounce.js';

export type FinalStatus = 'valid' | 'invalid' | 'catch-all' | 'unknown';
export type SourceStage = 'syntax' | 'dns' | 'catch-all' | 'smtp' | 'zerobounce';
export type SmtpResultLabel =
  | '250'
  | '550'
  | 'unknown'
  | 'skipped_catchall'
  | 'skipped_giant'
  | 'skipped_no_mx'
  | 'error';

export interface ValidationResult {
  email: string;
  status: FinalStatus;
  sourceStage: SourceStage;
  reason: string;                 // human-readable, surfaced in UI tooltip
  // Per-stage breakdown for the audit columns
  syntax_ok: boolean;
  mx_ok: boolean | null;
  smtp_result: SmtpResultLabel | null;
  zerobounce_result: FinalStatus | null;
  // Diagnostic
  mx_top: string | null;
  provider_type: ProviderType | null;
  is_catch_all_domain: boolean | null;
  raw_smtp_response: string | null;
}

interface OrchestratorOptions {
  heloDomain?: string;
  fromAddress?: string;
  // Optional progress callback so the verify route can stream stage events
  onStage?: (stage: string, detail: string) => void;
  // Skip ZeroBounce fallback (used by tests / when key is unset)
  skipZeroBounce?: boolean;
}

const DEFAULT_HELO = process.env.SMTP_PROBE_HELO || 'optiratesolutions.com';
const DEFAULT_FROM = process.env.SMTP_PROBE_FROM || 'verify@optiratesolutions.com';

const TERMINAL_INVALID = (email: string, syntax_ok: boolean, mx_ok: boolean | null, reason: string, sourceStage: SourceStage): ValidationResult => ({
  email,
  status: 'invalid',
  sourceStage,
  reason,
  syntax_ok,
  mx_ok,
  smtp_result: null,
  zerobounce_result: null,
  mx_top: null,
  provider_type: null,
  is_catch_all_domain: null,
  raw_smtp_response: null,
});

/**
 * Validate a single email through the full pipeline.
 *
 * Stages run sequentially, short-circuiting on a definitive verdict:
 *   1. Syntax  — instant, free
 *   2. DNS/MX  — ~100ms, free
 *   3. Catch-all probe (per-domain, cached 7 days) — ~3s, free
 *   4. SMTP RCPT-TO probe (per-address) — ~3s, free
 *   5. ZeroBounce fallback (only on `unknown`) — paid
 */
export async function validateEmail(
  email: string,
  opts: OrchestratorOptions = {},
): Promise<ValidationResult> {
  const heloDomain = opts.heloDomain || DEFAULT_HELO;
  const fromAddress = opts.fromAddress || DEFAULT_FROM;
  const emit = opts.onStage || (() => undefined);
  const norm = email.trim().toLowerCase();

  // ── Stage 1: Syntax ─────────────────────────────────────────────────────
  emit('syntax_check', norm);
  const syntax = checkSyntax(norm);
  if (!syntax.ok) {
    return TERMINAL_INVALID(norm, false, null, syntax.reason || 'Syntax check failed', 'syntax');
  }

  // ── Stage 2: DNS / MX ───────────────────────────────────────────────────
  emit('mx_check', norm);
  const dns = await checkDns(norm);
  if (!dns.hasMx) {
    return TERMINAL_INVALID(norm, true, false, dns.reason || 'No MX record', 'dns');
  }

  const domain = norm.split('@')[1];

  // ── Stage 3: Catch-all (per-domain, cached) ─────────────────────────────
  emit('catch_all_check', domain);
  let isCatchAll: boolean | null = null;
  let mxTop: string | null = dns.mxTop;
  let providerType: ProviderType | null = dns.providerType;

  const cached = await getCachedDomainIntel(domain);
  if (cached) {
    isCatchAll = cached.is_catch_all;
    mxTop = cached.mx_top || mxTop;
    providerType = (cached.provider_type as ProviderType | null) || providerType;
  } else if (mxTop) {
    // Skip catch-all probe for the giants — they 250 everything regardless,
    // so a "catch-all" verdict from them would be meaningless. Cache the
    // provider classification only.
    if (providerType === 'google_workspace' || providerType === 'outlook365') {
      isCatchAll = null;
      await upsertDomainIntel({ domain, mx_top: mxTop, provider_type: providerType, is_catch_all: null });
    } else {
      const ca = await probeCatchAll({ mxHost: mxTop, domain, heloDomain, fromAddress });
      isCatchAll = ca.isCatchAll;
      await upsertDomainIntel({ domain, mx_top: mxTop, provider_type: providerType, is_catch_all: ca.isCatchAll });
    }
  }

  // Catch-all domain → terminal verdict, never proceed to per-address probe.
  if (isCatchAll === true) {
    return {
      email: norm,
      status: 'catch-all',
      sourceStage: 'catch-all',
      reason: `Domain "${domain}" accepts any address (catch-all forwarding). Individual mailbox existence cannot be verified.`,
      syntax_ok: true,
      mx_ok: true,
      smtp_result: 'skipped_catchall',
      zerobounce_result: null,
      mx_top: mxTop,
      provider_type: providerType,
      is_catch_all_domain: true,
      raw_smtp_response: null,
    };
  }

  // ── Stage 4: SMTP RCPT-TO probe ─────────────────────────────────────────
  let smtp_result: SmtpResultLabel = 'unknown';
  let raw_smtp_response: string | null = null;

  if (!mxTop) {
    smtp_result = 'skipped_no_mx';
  } else if (providerType === 'google_workspace' || providerType === 'outlook365') {
    // The giants always 250 every address — running the probe would produce
    // a guess. Mark explicit `skipped_giant`; ZeroBounce takes over.
    smtp_result = 'skipped_giant';
  } else {
    emit('smtp_probe', norm);
    const probe = await rcptProbe({ mxHost: mxTop, email: norm, heloDomain, fromAddress });
    raw_smtp_response = probe.rawResponse;
    if (probe.code === '250')      smtp_result = '250';
    else if (probe.code === '550') smtp_result = '550';
    else if (probe.code === 'error') smtp_result = 'error';
    else                           smtp_result = 'unknown';
  }

  if (smtp_result === '250') {
    return {
      email: norm,
      status: 'valid',
      sourceStage: 'smtp',
      reason: `SMTP RCPT-TO returned 250 from ${mxTop} — mailbox exists.`,
      syntax_ok: true,
      mx_ok: true,
      smtp_result,
      zerobounce_result: null,
      mx_top: mxTop,
      provider_type: providerType,
      is_catch_all_domain: isCatchAll,
      raw_smtp_response,
    };
  }

  if (smtp_result === '550') {
    return {
      email: norm,
      status: 'invalid',
      sourceStage: 'smtp',
      reason: `SMTP RCPT-TO returned 550 from ${mxTop} — mailbox does not exist.`,
      syntax_ok: true,
      mx_ok: true,
      smtp_result,
      zerobounce_result: null,
      mx_top: mxTop,
      provider_type: providerType,
      is_catch_all_domain: isCatchAll,
      raw_smtp_response,
    };
  }

  // ── Stage 5: ZeroBounce fallback ────────────────────────────────────────
  // Only invoked when our stack returned `unknown`. This is the credit-saver.
  let zb: FinalStatus | null = null;
  if (!opts.skipZeroBounce && process.env.ZEROBOUNCE_API_KEY) {
    try {
      emit('zb_fallback', norm);
      const [zbResult] = await verifyEmailsZB([norm]);
      zb = zbResult?.status ?? null;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[validator] ZB fallback failed for ${norm}: ${m}`);
    }
  }

  if (zb && zb !== 'unknown') {
    return {
      email: norm,
      status: zb,
      sourceStage: 'zerobounce',
      reason: `ZeroBounce: ${zb}.`,
      syntax_ok: true,
      mx_ok: true,
      smtp_result,
      zerobounce_result: zb,
      mx_top: mxTop,
      provider_type: providerType,
      is_catch_all_domain: isCatchAll,
      raw_smtp_response,
    };
  }

  // ── No definitive answer anywhere ───────────────────────────────────────
  return {
    email: norm,
    status: 'unknown',
    sourceStage: 'smtp',
    reason: smtpUnknownReason(smtp_result, providerType),
    syntax_ok: true,
    mx_ok: true,
    smtp_result,
    zerobounce_result: zb,
    mx_top: mxTop,
    provider_type: providerType,
    is_catch_all_domain: isCatchAll,
    raw_smtp_response,
  };
}

function smtpUnknownReason(smtp: SmtpResultLabel, provider: ProviderType | null): string {
  if (smtp === 'skipped_giant') {
    return `Mailbox is hosted on ${provider === 'google_workspace' ? 'Google Workspace' : 'Outlook 365'}; these providers accept every RCPT-TO so a probe verdict would be a guess. Use Live Probe (Stage 6) or ZeroBounce for confirmation.`;
  }
  if (smtp === 'skipped_no_mx') return 'No MX record could be resolved for the domain.';
  if (smtp === 'error') return 'SMTP probe could not connect (port 25 blocked or MX unreachable).';
  return 'SMTP server returned a non-definitive response (greylisting / throttling).';
}

/**
 * Validate a batch of emails. Domain-level work (DNS, catch-all probe) is
 * cached in the DB so leads on the same domain reuse the answer. Per-address
 * SMTP probes run sequentially per-domain to avoid hammering a single MX,
 * but distinct domains run in parallel.
 */
export async function validateEmails(
  emails: string[],
  opts: OrchestratorOptions = {},
): Promise<ValidationResult[]> {
  // Group by domain so we serialize probes against the same MX.
  const byDomain = new Map<string, string[]>();
  for (const e of emails) {
    const domain = (e.split('@')[1] || '').toLowerCase();
    const list = byDomain.get(domain) || [];
    list.push(e);
    byDomain.set(domain, list);
  }

  const results: ValidationResult[] = [];
  // Process domains in parallel, addresses within a domain serial.
  const tasks = [...byDomain.values()].map(async (group) => {
    for (const e of group) {
      const r = await validateEmail(e, opts);
      results.push(r);
    }
  });

  await Promise.all(tasks);
  return results;
}

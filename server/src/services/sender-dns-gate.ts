/**
 * Pre-send DNS gate — refuses to dispatch a campaign when any pinned
 * SMTP sender's domain is missing MX, SPF, DMARC, or DKIM. Skips
 * gmail_oauth / app_password / env accounts (DNS is Google's
 * responsibility, not the user's). Reads the cached dns_* columns on
 * email_accounts; refreshes any row older than DNS_CACHE_TTL_MS.
 *
 * DKIM detection uses provider-aware selectors (titan1 for Titan,
 * google for Workspace, etc.) plus a generic fallback.
 */

import { getSupabase } from '../lib/supabase.js';
import { checkDomainHealth } from './dns-checker.js';

const DNS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — matches email-accounts.ts

export interface SenderDnsFailure {
  accountId: string;
  email: string;
  domain: string;
  failures: ('MX' | 'SPF' | 'DMARC' | 'DKIM')[];
  errors: string[];
}

export interface SenderDnsGateResult {
  ok: boolean;
  checked: number;
  skipped: number;
  failures: SenderDnsFailure[];
}

export async function gateSendersByDns(pinnedAccountIds: string[]): Promise<SenderDnsGateResult> {
  const dbIds = pinnedAccountIds.filter((id) => id && id !== '__env__');
  const envSkipped = pinnedAccountIds.length - dbIds.length;

  if (dbIds.length === 0) {
    return { ok: true, checked: 0, skipped: envSkipped, failures: [] };
  }

  const supabase = getSupabase();
  // Pull dns_dkim too; if migration 035 hasn't run, fall back without it.
  let accounts: Array<{ id: string; email: string; auth_type: string; dns_mx: boolean | null; dns_spf: boolean | null; dns_dmarc: boolean | null; dns_dkim: boolean | null; dns_checked_at: string | null }> = [];
  {
    const fullSel = await supabase
      .from('email_accounts')
      .select('id, email, auth_type, dns_mx, dns_spf, dns_dmarc, dns_dkim, dns_checked_at')
      .in('id', dbIds);
    if (fullSel.error && /dns_dkim/.test(fullSel.error.message)) {
      const fallback = await supabase
        .from('email_accounts')
        .select('id, email, auth_type, dns_mx, dns_spf, dns_dmarc, dns_checked_at')
        .in('id', dbIds);
      if (fallback.error) throw new Error(`DNS gate: ${fallback.error.message}`);
      accounts = (fallback.data ?? []).map((a) => ({ ...a, dns_dkim: null })) as typeof accounts;
    } else if (fullSel.error) {
      throw new Error(`DNS gate: ${fullSel.error.message}`);
    } else {
      accounts = fullSel.data ?? [];
    }
  }

  const failures: SenderDnsFailure[] = [];
  let checked = 0;
  let skipped = envSkipped;

  for (const a of accounts) {
    if (a.auth_type !== 'smtp') { skipped++; continue; }

    const domain = String(a.email).split('@')[1]?.toLowerCase();
    if (!domain) { skipped++; continue; }

    let mx    = !!a.dns_mx;
    let spf   = !!a.dns_spf;
    let dmarc = !!a.dns_dmarc;
    let dkim  = !!a.dns_dkim;
    const liveErrors: string[] = [];

    const checkedAt = a.dns_checked_at as string | null;
    const stale = !checkedAt || Date.now() - new Date(checkedAt).getTime() > DNS_CACHE_TTL_MS;

    if (stale) {
      try {
        const health = await checkDomainHealth(domain);
        mx    = health.mx.ok;
        spf   = health.spf.ok;
        dmarc = health.dmarc.ok;
        dkim  = health.dkim.ok;
        if (!health.mx.ok    && health.mx.error)    liveErrors.push(health.mx.error);
        if (!health.spf.ok   && health.spf.error)   liveErrors.push(health.spf.error);
        if (!health.dmarc.ok && health.dmarc.error) liveErrors.push(health.dmarc.error);
        if (!health.dkim.ok  && health.dkim.error)  liveErrors.push(health.dkim.error);
        const patch = {
          dns_mx: mx, dns_spf: spf, dns_dmarc: dmarc, dns_dkim: dkim,
          dns_checked_at: new Date().toISOString(),
        };
        const { error: updErr } = await supabase.from('email_accounts').update(patch).eq('id', a.id);
        if (updErr && /dns_dkim/.test(updErr.message)) {
          await supabase.from('email_accounts').update({
            dns_mx: mx, dns_spf: spf, dns_dmarc: dmarc,
            dns_checked_at: new Date().toISOString(),
          }).eq('id', a.id);
        }
      } catch (e) {
        liveErrors.push(`DNS lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    checked++;

    const failed: SenderDnsFailure['failures'] = [];
    if (!mx)    failed.push('MX');
    if (!spf)   failed.push('SPF');
    if (!dmarc) failed.push('DMARC');
    if (!dkim)  failed.push('DKIM');

    if (failed.length > 0) {
      failures.push({
        accountId: a.id,
        email: a.email,
        domain,
        failures: failed,
        errors: liveErrors.length ? liveErrors : failed.map((f) => `${f} record missing or invalid for ${domain}`),
      });
    }
  }

  return { ok: failures.length === 0, checked, skipped, failures };
}

/** Render a SenderDnsGateResult as a 1-line, copy-paste-ready error for 400 responses. */
export function formatGateError(result: SenderDnsGateResult): string {
  const summary = result.failures.map((f) => `${f.email} (missing: ${f.failures.join(', ')})`).join('; ');
  return `Send blocked: ${result.failures.length} sender domain${result.failures.length === 1 ? '' : 's'} failing DNS — ${summary}. Fix DNS on the Email Accounts page (MX, SPF, DMARC must all pass) before sending.`;
}

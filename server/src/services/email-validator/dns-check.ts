// Stage 2 — Domain DNS check.
//
// Resolves MX records (priority-sorted) and classifies the provider so the
// downstream SMTP probe can decide whether the host will give an honest
// RCPT-TO answer (cPanel, Bluehost, Zoho) or always lie (Gmail, Outlook365).
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
}

const GOOGLE_MX_SUFFIXES = ['google.com.', 'googlemail.com.', 'aspmx.l.google.com.', 'googlemail.com'];
const OUTLOOK_MX_SUFFIXES = ['outlook.com.', 'protection.outlook.com.', 'mail.protection.outlook.com.'];

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

  let records: Array<{ priority: number; exchange: string }> = [];
  try {
    records = await resolver.resolveMx(domain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { hasMx: false, mxTop: null, providerType: null, isDisposable: false, reason: `DNS error: ${msg}` };
  }

  if (!records.length) {
    return { hasMx: false, mxTop: null, providerType: null, isDisposable: false, reason: 'No MX records' };
  }

  records.sort((a, b) => a.priority - b.priority);
  const mxTop = records[0].exchange.toLowerCase().replace(/\.$/, '');
  const providerType = classifyProvider(records[0].exchange);

  return { hasMx: true, mxTop, providerType, isDisposable: false };
}

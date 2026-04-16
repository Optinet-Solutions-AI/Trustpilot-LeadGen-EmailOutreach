/**
 * DNS readiness checker — verifies MX, SPF, and DMARC records for a domain.
 * Uses Node's built-in dns/promises module — no external dependency.
 */

import { promises as dns } from 'dns';

export interface DnsCheckResult {
  mx: boolean;
  spf: boolean;
  dmarc: boolean;
}

export async function verifyDomainDNS(domain: string): Promise<DnsCheckResult> {
  const [mx, spf, dmarc] = await Promise.all([
    checkMx(domain),
    checkSpf(domain),
    checkDmarc(domain),
  ]);
  return { mx, spf, dmarc };
}

async function checkMx(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveMx(domain);
    return records.length > 0;
  } catch {
    return false;
  }
}

async function checkSpf(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveTxt(domain);
    return records.some((r) => r.join('').startsWith('v=spf1'));
  } catch {
    return false;
  }
}

async function checkDmarc(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    return records.some((r) => r.join('').startsWith('v=DMARC1'));
  } catch {
    return false;
  }
}

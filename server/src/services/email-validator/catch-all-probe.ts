// Stage 3 — Catch-all detection.
//
// We RCPT-TO a known-fake address at the domain. If the MX returns 250 for
// `nonexistent-{token}@domain.com`, the domain is configured to accept any
// address (catch-all forwarding). On a catch-all, we cannot prove individual
// mailbox existence — every address on it is labelled `catch-all`, never
// `valid`. This is the no-guessing rule made concrete.

import { randomBytes } from 'node:crypto';
import { rcptProbe, type SmtpProbeCode } from './smtp-probe.js';

export interface CatchAllResult {
  isCatchAll: boolean | null;       // null when probe couldn't determine (network error, port blocked)
  rawResponse: string;
  durationMs: number;
}

interface ProbeContext {
  mxHost: string;
  domain: string;
  heloDomain: string;
  fromAddress: string;
}

export async function probeCatchAll(ctx: ProbeContext): Promise<CatchAllResult> {
  const fakeUser = `nonexistent-${randomBytes(6).toString('hex')}`;
  const fakeEmail = `${fakeUser}@${ctx.domain}`;

  const result = await rcptProbe({
    mxHost: ctx.mxHost,
    email: fakeEmail,
    heloDomain: ctx.heloDomain,
    fromAddress: ctx.fromAddress,
  });

  let isCatchAll: boolean | null;
  if (result.code === '250') isCatchAll = true;       // accepted a fake address → catch-all
  else if (result.code === '550') isCatchAll = false; // properly rejected → not catch-all
  else isCatchAll = null;                             // network error / unknown — don't cache a guess

  return {
    isCatchAll,
    rawResponse: result.rawResponse,
    durationMs: result.durationMs,
  };
}

// Re-exported so callers don't need to know the underlying probe module.
export type { SmtpProbeCode };

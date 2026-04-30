// Raw SMTP RCPT-TO probe.
//
// Connects to the recipient's MX, runs HELO + MAIL FROM + RCPT TO + QUIT,
// never sends DATA. The response code at RCPT TO tells us whether the mailbox
// exists (if the host is honest about it).
//
//   250 → mailbox accepted (valid)
//   550 → mailbox rejected (invalid)
//   4xx, 421, timeout → unknown (greylisting, throttling, transient)
//
// We use the raw `net` module rather than nodemailer's smtp-connection to
// avoid coupling to nodemailer internals. SMTP is plain text — the protocol
// fits in 80 lines.

import { Socket } from 'node:net';

export type SmtpProbeCode = '250' | '550' | 'unknown' | 'error';

export interface SmtpProbeResult {
  code: SmtpProbeCode;
  rawResponse: string;       // last server line we saw — useful for diagnostics / UI tooltip
  bannerOk: boolean;         // did we get past the 220 greeting at all (network reachable)
  durationMs: number;
}

interface ProbeOptions {
  mxHost: string;
  email: string;             // candidate recipient
  heloDomain: string;        // our HELO domain (must be a real domain we own)
  fromAddress: string;       // MAIL FROM (any deliverable address on heloDomain)
  port?: number;             // default 25
  timeoutMs?: number;        // default 10000
}

/**
 * Run the probe. Always resolves; does not throw.
 *
 * Note: Outbound port 25 is blocked by many cloud providers (Cloud Run, AWS,
 * GCP standard projects). On those hosts the probe will return `error` /
 * connect timeout. The orchestrator treats that as `unknown` and falls back
 * to ZeroBounce.
 */
export function rcptProbe(opts: ProbeOptions): Promise<SmtpProbeResult> {
  const { mxHost, email, heloDomain, fromAddress, port = 25, timeoutMs = 10_000 } = opts;
  const start = Date.now();

  return new Promise((resolve) => {
    const socket = new Socket();
    let buffer = '';
    let bannerOk = false;
    let lastResponse = '';
    let step: 'banner' | 'helo' | 'mail' | 'rcpt' | 'quit' | 'done' = 'banner';
    let settled = false;

    const finish = (code: SmtpProbeCode) => {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch { /* swallow */ }
      try { socket.destroy(); } catch { /* swallow */ }
      resolve({
        code,
        rawResponse: lastResponse.trim().slice(0, 500),
        bannerOk,
        durationMs: Date.now() - start,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish('error'));
    socket.on('error', () => finish('error'));
    socket.on('close', () => {
      if (!settled) finish('error');
    });

    // Multi-line SMTP responses look like:
    //   250-mail.example.com\r\n250-PIPELINING\r\n250 OK\r\n
    // The final line uses a SPACE after the code; intermediate lines use a hyphen.
    const isCompleteResponse = (chunk: string) => {
      const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0);
      if (!lines.length) return false;
      const last = lines[lines.length - 1];
      return /^\d{3} /.test(last);
    };

    const codeOf = (chunk: string): string => {
      const m = chunk.match(/^(\d{3})/m);
      return m ? m[1] : '';
    };

    socket.on('data', (data) => {
      buffer += data.toString('utf8');
      if (!isCompleteResponse(buffer)) return;

      lastResponse = buffer;
      const code = codeOf(buffer);
      buffer = '';

      if (step === 'banner') {
        if (!code.startsWith('2')) return finish('error');
        bannerOk = true;
        step = 'helo';
        socket.write(`HELO ${heloDomain}\r\n`);
        return;
      }

      if (step === 'helo') {
        if (!code.startsWith('2')) return finish('error');
        step = 'mail';
        socket.write(`MAIL FROM:<${fromAddress}>\r\n`);
        return;
      }

      if (step === 'mail') {
        if (!code.startsWith('2')) return finish('error');
        step = 'rcpt';
        socket.write(`RCPT TO:<${email}>\r\n`);
        return;
      }

      if (step === 'rcpt') {
        // The verdict line. Parse and exit cleanly.
        let verdict: SmtpProbeCode = 'unknown';
        if (code === '250' || code === '251') verdict = '250';
        else if (code.startsWith('55')) verdict = '550';
        else if (code.startsWith('4')) verdict = 'unknown';
        else verdict = 'unknown';

        step = 'quit';
        try { socket.write('QUIT\r\n'); } catch { /* swallow */ }
        // Don't wait for QUIT response — finish immediately
        finish(verdict);
        return;
      }
    });

    socket.connect({ host: mxHost, port });
  });
}

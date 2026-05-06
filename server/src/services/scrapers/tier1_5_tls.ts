/**
 * Tier 1.5 — Chrome-TLS-fingerprint HTTP fetch via curl_cffi.
 *
 * Sits between the Node-based httpFastLane (Tier 1) and the Playwright stealth
 * tier (Tier 2). Spawns tools/scraper/tls_fetch.py which uses curl_cffi to
 * mimic Chrome's TLS handshake (JA3/JA4) — bypasses Cloudflare's first-line
 * fingerprint check on a large fraction of protected sites without paying for
 * a managed-proxy service or launching a headless browser.
 *
 * Tier configured to skip silently if curl_cffi isn't installed (it returns
 * an `error` field in the JSON output). Caller treats a tier 1.5 miss as
 * "no email yet" and escalates normally.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../../config.js';

interface TlsProbe {
  url: string;
  status: number;
  html?: string;
  blockReason: string | null;
  elapsedMs: number;
}

interface TlsFetchResult {
  probes: TlsProbe[];
  impersonate?: string;
  error: string | null;
}

const TLS_FETCH_PATHS = ['/', '/contact', '/contact-us', '/about', '/impressum', '/kontakt'];
const TLS_FETCH_MAX_PROBES = 4;
const TLS_FETCH_TIMEOUT_S = 8;
// Hard ceiling on the subprocess wall-clock — Python startup + 4 probes at 8s
// each = ~33s worst case. Anything longer than this and we'd be better off
// going straight to the browser tier.
const TLS_FETCH_SUBPROCESS_TIMEOUT_MS = 40_000;

/**
 * Spawn tls_fetch.py and parse its JSON stdout.
 * Returns null if the subprocess errored before producing output (curl_cffi
 * not installed, Python missing, hard timeout). Returns a result object with
 * probes[] otherwise — even if individual probes failed, the array is present.
 */
export async function tier1_5TlsFetch(
  websiteUrl: string,
  opts: { paths?: string[]; maxProbes?: number; timeoutS?: number } = {},
): Promise<TlsFetchResult | null> {
  const scriptPath = path.join(config.projectRoot, 'tools', 'scraper', 'tls_fetch.py');
  const paths = (opts.paths ?? TLS_FETCH_PATHS).join(',');
  const maxProbes = opts.maxProbes ?? TLS_FETCH_MAX_PROBES;
  const timeoutS = opts.timeoutS ?? TLS_FETCH_TIMEOUT_S;

  const args = [
    scriptPath,
    '--url', websiteUrl,
    '--paths', paths,
    '--max-probes', String(maxProbes),
    '--timeout', String(timeoutS),
  ];

  return new Promise<TlsFetchResult | null>((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const finish = (v: TlsFetchResult | null) => { if (!resolved) { resolved = true; resolve(v); } };

    const proc = spawn(config.pythonPath, args, {
      cwd: config.projectRoot,
      // Inherit env so PATH/system DNS settings work; no need to filter.
      env: process.env,
    });

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      finish(null);
    }, TLS_FETCH_SUBPROCESS_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      console.warn(`[tier1_5_tls] subprocess error: ${err.message}`);
      finish(null);
    });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (!stdout) {
        if (code !== 0 && stderr) {
          console.warn(`[tier1_5_tls] exit ${code}: ${stderr.slice(0, 200)}`);
        }
        return finish(null);
      }
      try {
        const parsed = JSON.parse(stdout) as TlsFetchResult;
        if (parsed.error) {
          // curl_cffi missing — log once per process so the user knows to install,
          // then suppress to avoid log spam on every lead.
          warnOnceCurlCffiMissing(parsed.error);
          return finish(null);
        }
        finish(parsed);
      } catch (err) {
        console.warn(`[tier1_5_tls] could not parse stdout: ${(err as Error).message}; first 200 chars: ${stdout.slice(0, 200)}`);
        finish(null);
      }
    });
  });
}

let _curlCffiWarned = false;
function warnOnceCurlCffiMissing(reason: string) {
  if (_curlCffiWarned) return;
  _curlCffiWarned = true;
  console.warn(`[tier1_5_tls] disabled — ${reason}`);
}

// Direct ScrapingBee API smoke test — bypasses the entire enricher pipeline.
// Tests the bare API call against known-blocked sites with the SAME parameters
// and timeouts that the production Tier 5 code uses.
//
// Why this exists: Cloud Run logs were masking the actual failure mode of
// Tier 5 (per-lead enricher logs not surfacing). Running the API call locally
// with full stdout makes the failure obvious — timeout vs auth vs 5xx vs hang.
//
// Usage (from /server):
//   npx tsx scripts/test-scrapingbee-direct.ts
//   npx tsx scripts/test-scrapingbee-direct.ts --url https://example.com
//   npx tsx scripts/test-scrapingbee-direct.ts --quick    # uses render_js=false (1 credit, fast)
//   npx tsx scripts/test-scrapingbee-direct.ts --no-premium # render_js=true but no premium proxy

import dotenv from 'dotenv';
import path from 'node:path';
// Explicitly load the project-root .env (not server/.env which doesn't exist)
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
import https from 'node:https';

const TEST_URLS = [
  'https://methwin.live',
  'https://ironman98.live',
  'https://outbackspins.org',
  'https://example.com',  // sanity check — should always succeed cheaply
];

interface Args {
  url: string | null;
  quick: boolean;
  noPremium: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let url: string | null = null;
  let quick = false;
  let noPremium = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) url = argv[++i];
    else if (argv[i] === '--quick') quick = true;
    else if (argv[i] === '--no-premium') noPremium = true;
  }
  return { url, quick, noPremium };
}

function fetchVia(targetUrl: string, opts: { renderJs: boolean; premiumProxy: boolean }): Promise<{
  status: number;
  body: string;
  durationMs: number;
  error?: string;
}> {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    return Promise.resolve({ status: 0, body: '', durationMs: 0, error: 'No SCRAPINGBEE_API_KEY in env' });
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render_js: String(opts.renderJs),
    premium_proxy: String(opts.premiumProxy),
    block_resources: 'false',  // matches production — true triggers 500 on some sites
    timeout: '70000',          // matches production
  });

  const apiUrl = `https://app.scrapingbee.com/api/v1/?${params.toString()}`;
  const SOCKET_TIMEOUT_MS = 90_000;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (v: { status: number; body: string; durationMs: number; error?: string }) => {
      if (!resolved) { resolved = true; resolve(v); }
    };

    const req = https.get(apiUrl, { timeout: SOCKET_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { if (body.length < 50_000) body += chunk; });
      res.on('end', () => finish({ status, body, durationMs: Date.now() - startedAt }));
      res.on('error', (err) => finish({ status, body, durationMs: Date.now() - startedAt, error: err.message }));
    });
    req.on('timeout', () => { req.destroy(); finish({ status: 0, body: '', durationMs: Date.now() - startedAt, error: 'socket timeout' }); });
    req.on('error', (err) => finish({ status: 0, body: '', durationMs: Date.now() - startedAt, error: err.message }));
  });
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

async function testOne(url: string, opts: { renderJs: boolean; premiumProxy: boolean }) {
  const cfg = `render_js=${opts.renderJs} premium_proxy=${opts.premiumProxy}`;
  console.log(`\n────── ${url}  [${cfg}] ──────`);
  const startMs = Date.now();
  const result = await fetchVia(url, opts);
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  if (result.error) {
    console.log(`  ✗ ERROR after ${elapsed}s: ${result.error}`);
    return;
  }

  console.log(`  ⏱  ${elapsed}s   status=${result.status}   bytes=${result.body.length}`);

  if (result.status !== 200) {
    console.log(`  ⚠  non-200 body (first 300 chars):\n     ${result.body.slice(0, 300).replace(/\n/g, ' ')}`);
    return;
  }

  // Extract any emails
  const emails = new Set<string>();
  for (const m of result.body.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
  // Also decode CF-encoded
  const cfPattern = /data-cfemail="([0-9a-fA-F]+)"/g;
  const cfMatches = [...result.body.matchAll(cfPattern)];

  console.log(`  ✓ HTML received   emails-in-html=${emails.size}   cf-encoded=${cfMatches.length}`);
  if (emails.size > 0) {
    const list = [...emails].slice(0, 5).join(', ');
    console.log(`     emails: ${list}${emails.size > 5 ? `, +${emails.size - 5} more` : ''}`);
  }
}

async function main() {
  const { url, quick, noPremium } = parseArgs();
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    console.error('FATAL: SCRAPINGBEE_API_KEY not set in .env');
    process.exit(1);
  }
  console.log(`API key prefix: ${apiKey.slice(0, 8)}…   length: ${apiKey.length}`);

  const targets = url ? [url] : TEST_URLS;

  // Production config (render_js=true + premium_proxy=true)
  const opts = {
    renderJs: !quick,
    premiumProxy: !quick && !noPremium,
  };

  for (const target of targets) {
    await testOne(target, opts);
  }

  console.log('\n────── done ──────');
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});

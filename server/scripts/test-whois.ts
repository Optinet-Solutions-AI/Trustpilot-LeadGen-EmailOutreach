// Tier 6 WHOIS smoke test — run locally to confirm the lookup actually
// produces useful registrant emails before wiring it into production.
//
// Usage (from /server):
//   npx tsx scripts/test-whois.ts
//   npx tsx scripts/test-whois.ts --url https://example.com

import { tier6WhoisLookup } from '../src/services/scrapers/tier6-whois.js';

const TEST_DOMAINS = [
  'https://google.com',                    // Big company, unlikely privacy-proxied
  'https://methwin.live',                  // AU casino — Tier 5 found 0 emails
  'https://ironman98.live',                // AU casino — Tier 5 found 0
  'https://outbackspins.org',              // AU casino — Tier 5 found 0
  'https://www.royalcasino.dk',            // Regulated DK casino
  'https://www.bo-peep.ie',                // Site that succeeded via Tier 2
  'https://stripe.com',                    // Big regulated company
  'https://anyslot.com',                   // From the lead DB
];

async function main() {
  const argv = process.argv.slice(2);
  const urlIdx = argv.indexOf('--url');
  const url = urlIdx >= 0 && argv[urlIdx + 1] ? argv[urlIdx + 1] : null;
  const targets = url ? [url] : TEST_DOMAINS;

  for (const target of targets) {
    console.log(`\n────── ${target} ──────`);
    const startedAt = Date.now();
    const result = await tier6WhoisLookup(target);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (result.email) {
      console.log(`  ✓ ${result.email}   (${elapsed}s, from ${result.source})`);
    } else {
      console.log(`  ✗ no email   (${elapsed}s)`);
    }
  }
  console.log('\n────── done ──────');
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});

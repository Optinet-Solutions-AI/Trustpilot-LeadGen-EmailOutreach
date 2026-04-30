// Live smoke test: pulls 5 real leads with trustpilot_email set, runs them
// through the layered validator, and prints a per-stage breakdown so the
// user can verify accuracy by hand.
//
// Usage (from /server):
//   npx tsx scripts/test-validator-live.ts
//   npx tsx scripts/test-validator-live.ts --skip-zb   (skip ZeroBounce fallback)
//   npx tsx scripts/test-validator-live.ts --count 10
//   npx tsx scripts/test-validator-live.ts --leads <id1>,<id2>,...

import 'dotenv/config';
import { getSupabase } from '../src/lib/supabase.js';
import { validateEmail } from '../src/services/email-validator/index.js';

interface Args {
  count: number;
  skipZb: boolean;
  leadIds: string[] | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let count = 5;
  let skipZb = false;
  let leadIds: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-zb') skipZb = true;
    else if (a === '--count' && argv[i + 1]) { count = parseInt(argv[++i], 10) || 5; }
    else if (a === '--leads' && argv[i + 1]) { leadIds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); }
  }
  return { count, skipZb, leadIds };
}

async function main() {
  const args = parseArgs();
  const supabase = getSupabase();

  // Pull 5 distinct leads with a non-null trustpilot_email. Prefer un-verified
  // ones so the test reflects real cold scrape data, but fall back to anyone
  // with an address if there aren't enough.
  let q = supabase
    .from('leads')
    .select('id, company_name, country, trustpilot_email, verification_status')
    .not('trustpilot_email', 'is', null)
    .limit(args.count);

  if (args.leadIds && args.leadIds.length > 0) {
    q = q.in('id', args.leadIds);
  }

  const { data: leads, error } = await q;
  if (error) throw new Error(`leads query failed: ${error.message}`);
  if (!leads || leads.length === 0) {
    console.log('No leads with trustpilot_email found.');
    return;
  }

  console.log('');
  console.log(`Testing ${leads.length} lead(s) — skipZB=${args.skipZb}\n`);
  console.log('═'.repeat(100));

  for (const lead of leads) {
    const email = lead.trustpilot_email as string;
    console.log('');
    console.log(`Lead:    ${lead.company_name} (${lead.country || '—'})`);
    console.log(`Email:   ${email}`);
    console.log(`Prior:   ${lead.verification_status || '—'}`);
    console.log('─'.repeat(100));

    const start = Date.now();
    let result;
    try {
      result = await validateEmail(email, {
        skipZeroBounce: args.skipZb,
        onStage: (stage, detail) => {
          process.stdout.write(`  · ${stage.padEnd(20)} ${detail.length > 60 ? detail.slice(0, 60) + '…' : detail}\n`);
        },
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.log(`  ✖ Validator threw: ${m}`);
      continue;
    }
    const dur = Date.now() - start;

    console.log('');
    console.log(`  Verdict:         ${result.status.toUpperCase()}`);
    console.log(`  Source stage:    ${result.sourceStage}`);
    console.log(`  Reason:          ${result.reason}`);
    console.log(`  ─ Stages ─`);
    console.log(`  Syntax ok:       ${result.syntax_ok}`);
    console.log(`  MX ok:           ${result.mx_ok}`);
    console.log(`  MX top:          ${result.mx_top || '—'}`);
    console.log(`  Provider:        ${result.provider_type || '—'}`);
    console.log(`  Catch-all:       ${result.is_catch_all_domain === null ? '—' : result.is_catch_all_domain}`);
    console.log(`  SMTP probe:      ${result.smtp_result || '—'}`);
    if (result.raw_smtp_response) {
      console.log(`  SMTP raw:        ${result.raw_smtp_response.slice(0, 160).replace(/\r?\n/g, ' | ')}`);
    }
    console.log(`  ZeroBounce:      ${result.zerobounce_result || '—'}`);
    console.log(`  Total time:      ${dur}ms`);
    console.log('═'.repeat(100));
  }

  console.log('');
  console.log('Done. Manually check each verdict against your knowledge of the company.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

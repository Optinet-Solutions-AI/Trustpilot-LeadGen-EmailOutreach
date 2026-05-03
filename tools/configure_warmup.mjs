// One-off: configure warmup roles + ramp on existing email_accounts.
//
//   Cold senders (auth_type='smtp')          → 7-day ramp, target_cap=30, is_cold_sender=true
//   Gmail accounts (gmail_oauth/app_password) → warmup peers, is_cold_sender=false
//
// Run:  node tools/configure_warmup.mjs

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: accounts, error } = await sb
  .from('email_accounts')
  .select('id, email, from_name, auth_type, is_cold_sender, warmup_enabled, warmup_started_at, warmup_target_cap, warmup_ramp_days, status')
  .order('created_at');

if (error) {
  console.error('Could not list accounts:', error.message);
  process.exit(1);
}

console.log(`Found ${accounts.length} account(s):\n`);
for (const a of accounts) {
  console.log(`  ${a.email.padEnd(40)} ${a.auth_type.padEnd(14)} status=${a.status}`);
}
console.log('');

const now = new Date().toISOString();
let updates = 0;

for (const a of accounts) {
  // Skip inactive accounts entirely.
  if (a.status !== 'active') continue;

  let patch = null;

  // Detect free-provider domains (treated as peers regardless of auth_type,
  // since the peer onboarding flow stores them with auth_type='smtp' + IMAP).
  const domain = a.email.split('@')[1]?.toLowerCase() ?? '';
  const isFreeProvider = /^(gmail\.com|googlemail\.com|yahoo\.com|ymail\.com|aol\.com|outlook\.com|hotmail\.com|live\.com|icloud\.com|me\.com)$/.test(domain);

  if (isFreeProvider || a.auth_type === 'gmail_oauth' || a.auth_type === 'app_password') {
    // Free-provider account → warmup peer (never sends cold mail)
    patch = {
      is_cold_sender:    false,
      warmup_enabled:    true,
      warmup_started_at: a.warmup_started_at ?? now,
      warmup_daily_target: 5,
      // Wipe any cold-sender ramp config that may have been mis-applied
      warmup_target_cap: 50,
      warmup_ramp_days:  21,
    };
    console.log(`PEER     ${a.email}  (free provider — receives only)`);
  } else if (a.auth_type === 'smtp') {
    // Custom-domain SMTP account → cold sender on 7-day compressed ramp
    patch = {
      is_cold_sender:    true,
      warmup_enabled:    true,
      warmup_started_at: a.warmup_started_at ?? now,
      warmup_target_cap: 30,
      warmup_ramp_days:  7,
    };
    console.log(`SENDER   ${a.email}  (7-day ramp → 30/day)`);
  } else {
    console.log(`SKIP     ${a.email}  (auth_type=${a.auth_type})`);
    continue;
  }

  const { error: upErr } = await sb.from('email_accounts').update(patch).eq('id', a.id);
  if (upErr) {
    console.error(`         FAILED:`, upErr.message);
    continue;
  }
  updates++;
}

console.log(`\nUpdated ${updates} account(s).`);

// Show final pool state
const { data: pool } = await sb
  .from('email_accounts')
  .select('email, auth_type, is_cold_sender, warmup_enabled, warmup_started_at, warmup_target_cap, warmup_ramp_days')
  .eq('status', 'active')
  .eq('warmup_enabled', true);

console.log(`\nWarmup pool now has ${pool?.length ?? 0} active account(s):`);
for (const p of pool ?? []) {
  const role = p.is_cold_sender ? 'sender' : 'peer  ';
  const ramp = p.is_cold_sender ? `→ ${p.warmup_target_cap}/day in ${p.warmup_ramp_days}d` : '(receives only)';
  console.log(`  [${role}] ${p.email.padEnd(40)} ${ramp}`);
}

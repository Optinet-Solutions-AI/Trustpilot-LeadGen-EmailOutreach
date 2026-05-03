// Restore standard warmup volume once the pool has 4+ peers.
//
//  Senders: warmup_daily_target → 5
//  Peers:   warmup_daily_target → 5
//
// Run when the warmup pool has at least 6 total accounts (3 senders + 3+ peers).

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await sb
  .from('email_accounts')
  .select('id, email, is_cold_sender')
  .eq('warmup_enabled', true)
  .eq('status', 'active');

if (error) { console.error(error.message); process.exit(1); }

const peerCount = data.filter(a => !a.is_cold_sender).length;
if (peerCount < 3) {
  console.warn(`⚠  Only ${peerCount} peer(s) in pool. Recommend 3+ before dialing up.`);
  console.warn('Continuing anyway since you ran this explicitly.\n');
}

console.log(`Restoring standard warmup volume on ${data.length} account(s):\n`);
for (const a of data) {
  const role = a.is_cold_sender ? 'sender' : 'peer  ';
  await sb.from('email_accounts')
    .update({ warmup_daily_target: 5 })
    .eq('id', a.id);
  console.log(`  [${role}] ${a.email.padEnd(40)} target = 5/day`);
}

console.log('\nDone. Pool back to 5 sends/day per account.');

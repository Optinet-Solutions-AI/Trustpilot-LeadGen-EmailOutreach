// Temporarily reduce warmup volume while pool is tiny.
// Run once today, then run dial_up_warmup.mjs once 4+ peers are added.
//
//  Senders: warmup_daily_target 5 → 3   (slightly more reputation work)
//  Peers:   warmup_daily_target 5 → 2   (peers should look responsive, not chatty)
//
// Math with current pool (3 senders + 1 peer):
//   Senders produce 9 warmup sends/day (was 15)
//   Peer produces 2 sends/day (was 5)
//   Each sender→peer pair fires ~1×/day (was ~1.7×)  — safer pattern
//   Total pool volume: 11 emails/day (was 20)

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

console.log(`Adjusting ${data.length} active warmup account(s):\n`);
for (const a of data) {
  const target = a.is_cold_sender ? 3 : 2;
  const role   = a.is_cold_sender ? 'sender' : 'peer  ';
  await sb.from('email_accounts')
    .update({ warmup_daily_target: target })
    .eq('id', a.id);
  console.log(`  [${role}] ${a.email.padEnd(40)} target = ${target}/day`);
}

console.log('\nDone. Senders will send 3/day each, peer will send 2/day until you re-run dial_up.');

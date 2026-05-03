// Quick status snapshot of the warmup pool + recent activity.
// Run:  node tools/warmup_status.mjs

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const { data: rows } = await sb
  .from('warmup_emails')
  .select('from_account, to_account, stage, sent_at, opened_at, replied_at, reply_read_at')
  .gte('sent_at', since)
  .order('sent_at', { ascending: false });

const stageCount = { pending_open: 0, pending_reply: 0, pending_read: 0, complete: 0, failed: 0 };
for (const r of rows ?? []) stageCount[r.stage] = (stageCount[r.stage] ?? 0) + 1;

console.log(`\nWarmup activity (last 24h): ${rows?.length ?? 0} emails\n`);
console.log(`  pending_open  ${stageCount.pending_open}   (sent, waiting to be opened)`);
console.log(`  pending_reply ${stageCount.pending_reply}  (opened, waiting to be replied to)`);
console.log(`  pending_read  ${stageCount.pending_read}   (replied, waiting for sender to read)`);
console.log(`  complete      ${stageCount.complete}       (full cycle done)`);
console.log(`  failed        ${stageCount.failed}\n`);

if ((rows?.length ?? 0) > 0) {
  console.log('Latest 10:\n');
  for (const r of (rows ?? []).slice(0, 10)) {
    const t = new Date(r.sent_at).toLocaleTimeString();
    console.log(`  ${t}  ${r.from_account.padEnd(40)} → ${r.to_account.padEnd(40)} [${r.stage}]`);
  }
}

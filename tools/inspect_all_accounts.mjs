// Show every row in email_accounts (incl. inactive) and which warmup fields are set.
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await sb
  .from('email_accounts')
  .select('id, email, status, auth_type, is_cold_sender, warmup_enabled, warmup_started_at, gmail_refresh_token, smtp_host, imap_host, created_at')
  .order('created_at');

if (error) { console.error(error.message); process.exit(1); }

console.log(`Found ${data.length} row(s):\n`);
for (const a of data) {
  console.log(`  ${a.email}`);
  console.log(`    status:           ${a.status}`);
  console.log(`    auth_type:        ${a.auth_type}`);
  console.log(`    is_cold_sender:   ${a.is_cold_sender}`);
  console.log(`    warmup_enabled:   ${a.warmup_enabled}`);
  console.log(`    warmup_started:   ${a.warmup_started_at ?? 'null'}`);
  console.log(`    gmail_refresh:    ${a.gmail_refresh_token ? 'set ✓' : 'missing'}`);
  console.log(`    smtp_host:        ${a.smtp_host ?? 'null'}`);
  console.log(`    imap_host:        ${a.imap_host ?? 'null'}`);
  console.log(`    created:          ${a.created_at}`);
  console.log('');
}

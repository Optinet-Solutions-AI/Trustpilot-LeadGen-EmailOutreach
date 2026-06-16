/**
 * One-off backfill: reclassify campaign_leads marked 'replied' that are
 * actually automated acknowledgements (ticket auto-acks, out-of-office, shared-
 * inbox autoresponders).
 *
 * Why this exists: the auto-reply classifier was tightened (2026-06-16) to
 * catch helpdesk ticket acks that previously scored just under threshold and
 * landed as human "Replied" (e.g. the Home Teeth Whitening "Your request
 * (115344) has been received … within 24-48 hours" ack). This corrects the
 * historical rows so reply stats reflect real human engagement only.
 *
 * Detection re-fetches each reply from the sender mailbox (reply_snippet is
 * NULL for ~all historical rows) and runs the SAME classifyReply the live
 * trackers use. A row is flipped only when its matched message classifies as
 * 'auto' or 'ticket'; genuine human replies are left untouched.
 *
 * For each detected row (in --apply mode):
 *   - campaign_leads.status        'replied' → 'auto_replied'
 *   - campaigns.total_replied      decremented, total_auto_replied incremented
 *   - leads.outreach_status        'replied' → 'contacted' (only if the lead has
 *                                  no OTHER genuine replied campaign_lead)
 *   - an 'auto_reply_received' note with source='backfill'
 *   (discovery extraction is NOT run for backfilled rows — promote manually if needed)
 *
 * Usage (from /server):
 *   npx tsx scripts/reclassify-auto-replies.ts          # dry run
 *   npx tsx scripts/reclassify-auto-replies.ts --apply  # write changes
 */

import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getSupabase } from '../src/lib/supabase.js';
import { createNote } from '../src/db/notes.js';
import { classifyReply } from '../src/services/auto-reply-detector.js';

const APPLY = process.argv.includes('--apply');

interface Row {
  id: string;
  lead_id: string;
  campaign_id: string;
  email_used: string | null;
  sender_email: string | null;
  gmail_message_id: string | null;
  replied_at: string | null;
  company: string | null;
}

interface ImapAccount {
  email: string; imap_host: string; imap_port: number; imap_user: string; imap_pass: string;
}

interface Candidate {
  row: Row;
  kind: 'auto' | 'ticket';
  confidence: number;
  signals: string[];
  fromHdr: string;
}

function normalizeMessageId(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/^</, '').replace(/>$/, '').toLowerCase();
}

async function loadRows(): Promise<Row[]> {
  const supabase = getSupabase();
  const rows: Row[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('campaign_leads')
      .select('id, lead_id, campaign_id, email_used, sender_email, gmail_message_id, replied_at, leads(company_name)')
      .eq('status', 'replied')
      .order('replied_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as any[];
    for (const r of batch) {
      rows.push({
        id: r.id, lead_id: r.lead_id, campaign_id: r.campaign_id, email_used: r.email_used,
        sender_email: r.sender_email, gmail_message_id: r.gmail_message_id, replied_at: r.replied_at,
        company: (r.leads as { company_name?: string } | null)?.company_name ?? null,
      });
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function scanAccount(acc: ImapAccount, targets: Row[]): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  const byMsgId = new Map<string, Row>();
  const byEmail = new Map<string, Row>();
  let earliest = Date.now();
  for (const r of targets) {
    const mid = normalizeMessageId(r.gmail_message_id);
    if (mid) byMsgId.set(mid, r);
    if (r.email_used) byEmail.set(r.email_used.toLowerCase(), r);
    if (r.replied_at) earliest = Math.min(earliest, new Date(r.replied_at).getTime());
  }
  const sinceDate = new Date(Math.max(earliest - 2 * 24 * 60 * 60 * 1000, Date.now() - 120 * 24 * 60 * 60 * 1000));

  const client = new ImapFlow({
    host: acc.imap_host, port: acc.imap_port, secure: true,
    auth: { user: acc.imap_user, pass: acc.imap_pass },
    logger: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 120000,
  });
  client.on('error', (e: Error) => console.warn(`  [${acc.email}] socket: ${e.message}`));

  let connected = false;
  try {
    await client.connect();
    connected = true;
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ since: sinceDate });
      const list = Array.isArray(uids) ? uids : [];
      console.log(`  [${acc.email}] ${targets.length} target(s), scanning ${list.length} inbox message(s) since ${sinceDate.toISOString().slice(0, 10)}`);
      if (list.length === 0) return out;

      const matches: { uid: number; row: Row }[] = [];
      for await (const msg of client.fetch(list, { envelope: true, uid: true, headers: ['references', 'in-reply-to'] })) {
        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';
        let row: Row | undefined;
        if (fromAddr) row = byEmail.get(fromAddr);
        if (!row) {
          const irt = normalizeMessageId(msg.envelope?.inReplyTo);
          if (irt) row = byMsgId.get(irt);
        }
        if (!row) {
          const refs = (msg.headers?.toString('utf8') ?? '').match(/<[^<>]+>/g) ?? [];
          for (const ref of refs) { row = byMsgId.get(normalizeMessageId(ref)); if (row) break; }
        }
        if (row && !out.has(row.id)) matches.push({ uid: msg.uid!, row });
      }

      for (const { uid, row } of matches) {
        if (out.has(row.id)) continue;
        let raw: Buffer | null = null;
        for await (const m of client.fetch(String(uid), { uid: true, source: true }, { uid: true })) {
          if (m.source) raw = m.source as Buffer;
        }
        if (!raw) continue;
        const parsed = await simpleParser(raw, { skipImageLinks: true });
        const headers: Record<string, string | string[] | undefined> = {};
        parsed.headers.forEach((value, key) => {
          headers[key] = typeof value === 'string' ? value : (value as { toString?: () => string })?.toString?.() ?? '';
        });
        const fromAddr = parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? '';
        const subject = parsed.subject ?? '';
        const body = (parsed.text ?? (parsed.html ? String(parsed.html) : '')) || '';
        const v = classifyReply({ headers, subject, body });
        if (v.kind === 'auto' || v.kind === 'ticket') {
          out.set(row.id, { row, kind: v.kind, confidence: v.confidence, signals: v.signals, fromHdr: fromAddr || '(none)' });
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.warn(`  [${acc.email}] IMAP error: ${e instanceof Error ? e.message : e}`);
  } finally {
    if (connected) { try { await client.logout(); } catch { /* ignore */ } }
  }
  return out;
}

async function moveCounter(campaignId: string): Promise<void> {
  const supabase = getSupabase();
  const { data: c } = await supabase
    .from('campaigns')
    .select('total_replied, total_auto_replied')
    .eq('id', campaignId)
    .single();
  if (!c) return;
  await supabase.from('campaigns').update({
    total_replied: Math.max(0, (c.total_replied || 0) - 1),
    total_auto_replied: (c.total_auto_replied || 0) + 1,
  }).eq('id', campaignId);
}

async function fixLead(leadId: string): Promise<void> {
  const supabase = getSupabase();
  const { data: lead } = await supabase.from('leads').select('outreach_status').eq('id', leadId).single();
  if (lead?.outreach_status !== 'replied') return;
  const { count } = await supabase
    .from('campaign_leads')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId)
    .eq('status', 'replied');
  if ((count ?? 0) === 0) {
    await supabase.from('leads').update({ outreach_status: 'contacted' }).eq('id', leadId);
  }
}

async function applyOne(c: Candidate): Promise<boolean> {
  const supabase = getSupabase();
  const { row, kind, confidence, signals } = c;
  const { data: updated, error } = await supabase
    .from('campaign_leads')
    .update({ status: 'auto_replied' })
    .eq('id', row.id)
    .eq('status', 'replied')
    .select('id');
  if (error) { console.error(`  ! ${row.id}: ${error.message}`); return false; }
  if (!updated || updated.length === 0) { console.warn(`  ~ ${row.id}: skipped (status changed since scan)`); return false; }

  await moveCounter(row.campaign_id);
  await fixLead(row.lead_id);
  await createNote(row.lead_id, {
    type: 'auto_reply_received',
    content: `Reclassified replied → auto_replied (${kind}, conf=${confidence.toFixed(2)}, backfill)`,
    metadata: { campaign_id: row.campaign_id, kind, confidence, signals, source: 'backfill', previous_status: 'replied' },
  });
  return true;
}

async function main(): Promise<void> {
  console.log(`[reclassify-auto-replies] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const supabase = getSupabase();

  const rows = await loadRows();
  console.log(`[reclassify-auto-replies] ${rows.length} 'replied' row(s) to re-check\n`);

  const bySender = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.sender_email) continue;
    const k = r.sender_email.toLowerCase();
    if (!bySender.has(k)) bySender.set(k, []);
    bySender.get(k)!.push(r);
  }

  const { data: accountsData } = await supabase
    .from('email_accounts')
    .select('email, imap_host, imap_port, imap_user, imap_pass')
    .in('email', [...bySender.keys()])
    .not('imap_pass', 'is', null);
  const accounts: ImapAccount[] = (accountsData ?? []).map((a: any) => ({
    email: (a.email as string).toLowerCase(),
    imap_host: a.imap_host, imap_port: a.imap_port ?? 993, imap_user: a.imap_user, imap_pass: a.imap_pass,
  }));
  console.log(`[reclassify-auto-replies] scanning ${accounts.length} mailbox(es) (read-only)…`);

  const candidates = new Map<string, Candidate>();
  for (const acc of accounts) {
    const found = await scanAccount(acc, bySender.get(acc.email) ?? []);
    for (const [id, c] of found) candidates.set(id, c);
  }

  const list = [...candidates.values()];
  if (list.length === 0) { console.log('\nNo mislabeled auto-replies found. Nothing to do.'); return; }

  console.table(list.map((c) => ({
    company: c.row.company ?? '—',
    from: c.fromHdr,
    kind: c.kind,
    conf: c.confidence.toFixed(2),
    signals: c.signals.slice(0, 4).join(','),
  })));
  console.log(`\n${list.length} mislabeled auto-repl(y/ies) detected.`);

  if (!APPLY) { console.log('\nDRY-RUN — no changes written. Re-run with --apply to reclassify.'); return; }

  console.log('\nApplying…');
  let done = 0;
  for (const c of list) if (await applyOne(c)) done++;
  console.log(`\nDone. Reclassified ${done}/${list.length} row(s) to 'auto_replied'.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[reclassify-auto-replies] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

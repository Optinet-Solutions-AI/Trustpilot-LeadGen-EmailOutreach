/**
 * One-off backfill: reclassify campaign_leads that were marked 'replied'
 * (or 'auto_replied') but are actually delivery-failure notifications (NDRs).
 *
 * Why this exists: before the bounce guard shipped (commit b9cc8fc, 2026-06-15)
 * the reply trackers matched Mail Delivery Subsystem NDRs via the threaded
 * In-Reply-To/References headers and counted hard bounces as human replies.
 * Those historical rows still show a green "Replied" tag and inflate reply
 * stats (e.g. the Popshelf "Address not found" bounce from 2026-06-11).
 *
 * The stored reply_snippet is NULL for ~all historical rows (they predate
 * snippet-saving), so detection cannot run from the DB alone — it must re-fetch
 * the inbound message from each sender's mailbox. This mirrors the LIVE IMAP
 * tracker exactly:
 *   - a bounce threads under our outgoing Message-ID, so we match candidates by
 *     In-Reply-To / References → campaign_leads.gmail_message_id (NOT by From,
 *     which is mailer-daemon), with a From-address match as a secondary signal
 *   - the matched message body runs through classifyInboundBounce
 * A row is only flipped when its matched message is an actual bounce; genuine
 * human replies and auto-replies are left untouched.
 *
 * For each detected row (in --apply mode):
 *   - campaign_leads.status            'replied'/'auto_replied' → 'bounced'
 *   - campaigns.total_replied / total_auto_replied  decremented (the count moves)
 *   - campaigns.total_bounced          incremented
 *   - leads.outreach_status            'replied' → 'contacted' (only if the lead
 *                                      has no OTHER genuine replied campaign_lead)
 *   - leads (hard bounce only)         email_verified=false, verification_status='invalid'
 *   - an 'email_bounced' activity note with source='backfill'
 *
 * Usage (from /server):
 *   npx tsx scripts/reclassify-bounces.ts                 # dry run, scans replied+auto_replied
 *   npx tsx scripts/reclassify-bounces.ts --replied-only  # skip auto_replied rows
 *   npx tsx scripts/reclassify-bounces.ts --apply         # actually write changes
 */

import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getSupabase } from '../src/lib/supabase.js';
import { createNote } from '../src/db/notes.js';
import { classifyInboundBounce, classifyBounceFromSnippet } from '../src/services/bounce-tracker.js';

const APPLY = process.argv.includes('--apply');
const REPLIED_ONLY = process.argv.includes('--replied-only');

interface Row {
  id: string;
  lead_id: string;
  campaign_id: string;
  status: 'replied' | 'auto_replied';
  email_used: string | null;
  sender_email: string | null;
  gmail_message_id: string | null;
  replied_at: string | null;
  reply_snippet: string | null;
  company: string | null;
}

interface ImapAccount {
  email: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
}

interface Candidate {
  row: Row;
  type: 'hard' | 'soft';
  bouncedEmail: string | null;
  via: 'imap' | 'snippet';
  fromHdr?: string;
  subject?: string;
}

function normalizeMessageId(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/^</, '').replace(/>$/, '').toLowerCase();
}

function preview(s: string | null, n = 90): string {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, n);
}

async function loadRows(): Promise<Row[]> {
  const supabase = getSupabase();
  const statuses = REPLIED_ONLY ? ['replied'] : ['replied', 'auto_replied'];
  const rows: Row[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('campaign_leads')
      .select('id, lead_id, campaign_id, status, email_used, sender_email, gmail_message_id, replied_at, reply_snippet, leads(company_name)')
      .in('status', statuses)
      .order('replied_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as any[];
    for (const r of batch) {
      rows.push({
        id: r.id, lead_id: r.lead_id, campaign_id: r.campaign_id, status: r.status,
        email_used: r.email_used, sender_email: r.sender_email, gmail_message_id: r.gmail_message_id,
        replied_at: r.replied_at, reply_snippet: r.reply_snippet,
        company: (r.leads as { company_name?: string } | null)?.company_name ?? null,
      });
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

/** Scan one sender mailbox; return a bounce verdict per resolved row id. */
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
  // Window: 2 days before the earliest mark, floored to 120 days back.
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

      // Pass 1 — match by envelope (msgid threading) or From, cheaply.
      const matches: { uid: number; row: Row }[] = [];
      for await (const msg of client.fetch(list, { envelope: true, uid: true, headers: ['references', 'in-reply-to'] })) {
        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';
        let row: Row | undefined;

        const irt = normalizeMessageId(msg.envelope?.inReplyTo);
        if (irt) row = byMsgId.get(irt);
        if (!row) {
          const refsHeader = msg.headers?.toString('utf8') ?? '';
          const refs = refsHeader.match(/<[^<>]+>/g) ?? [];
          for (const ref of refs) {
            row = byMsgId.get(normalizeMessageId(ref));
            if (row) break;
          }
        }
        if (!row && fromAddr) row = byEmail.get(fromAddr);
        if (row && !out.has(row.id)) matches.push({ uid: msg.uid!, row });
      }

      // Pass 2 — fetch body only for matched candidates and confirm bounce.
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
        const v = classifyInboundBounce({ fromAddr, subject, headers, body });
        if (v.isBounce) {
          out.set(row.id, {
            row, type: v.type, bouncedEmail: v.bouncedEmail ?? row.email_used, via: 'imap',
            fromHdr: fromAddr || '(none)', subject: subject.slice(0, 50),
          });
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

async function moveCampaignCounter(campaignId: string, fromStatus: Row['status']): Promise<void> {
  const supabase = getSupabase();
  const { data: c } = await supabase
    .from('campaigns')
    .select('total_replied, total_auto_replied, total_bounced')
    .eq('id', campaignId)
    .single();
  if (!c) return;
  const patch: Record<string, number> = { total_bounced: (c.total_bounced || 0) + 1 };
  if (fromStatus === 'replied') patch.total_replied = Math.max(0, (c.total_replied || 0) - 1);
  else patch.total_auto_replied = Math.max(0, (c.total_auto_replied || 0) - 1);
  await supabase.from('campaigns').update(patch).eq('id', campaignId);
}

async function fixLead(leadId: string, type: 'hard' | 'soft'): Promise<void> {
  const supabase = getSupabase();
  if (type === 'hard') {
    await supabase.from('leads')
      .update({ email_verified: false, verification_status: 'invalid' })
      .eq('id', leadId);
  }
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
  const { row, type, bouncedEmail } = c;
  const { data: updated, error } = await supabase
    .from('campaign_leads')
    .update({ status: 'bounced' })
    .eq('id', row.id)
    .eq('status', row.status)
    .select('id');
  if (error) { console.error(`  ! ${row.id}: ${error.message}`); return false; }
  if (!updated || updated.length === 0) { console.warn(`  ~ ${row.id}: skipped (status changed since scan)`); return false; }

  await moveCampaignCounter(row.campaign_id, row.status);
  await fixLead(row.lead_id, type);
  await createNote(row.lead_id, {
    type: 'email_bounced',
    content: `Reclassified ${row.status} → bounced (${type} bounce, backfill via ${c.via})${bouncedEmail ? ` — ${bouncedEmail}` : ''}`,
    metadata: {
      campaign_id: row.campaign_id, bounce_type: type, bounced_email: bouncedEmail ?? row.email_used,
      source: 'backfill', previous_status: row.status, detected_via: c.via,
    },
  });
  return true;
}

async function main(): Promise<void> {
  console.log(`[reclassify-bounces] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} statuses=${REPLIED_ONLY ? 'replied' : 'replied+auto_replied'}`);
  const supabase = getSupabase();

  const rows = await loadRows();
  console.log(`[reclassify-bounces] ${rows.length} candidate row(s) to re-check\n`);

  // Group by sender for the IMAP scan.
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
  console.log(`[reclassify-bounces] scanning ${accounts.length} mailbox(es) (read-only)…`);

  const candidates = new Map<string, Candidate>();
  for (const acc of accounts) {
    const found = await scanAccount(acc, bySender.get(acc.email) ?? []);
    for (const [id, c] of found) candidates.set(id, c);
  }

  // Snippet fallback for any row IMAP didn't resolve but that kept a body.
  let snippetHits = 0;
  for (const r of rows) {
    if (candidates.has(r.id) || !r.reply_snippet) continue;
    const v = classifyBounceFromSnippet(r.reply_snippet, r.email_used);
    if (v.isBounce) {
      candidates.set(r.id, { row: r, type: v.type, bouncedEmail: v.bouncedEmail, via: 'snippet' });
      snippetHits++;
    }
  }

  const list = [...candidates.values()];
  if (list.length === 0) {
    console.log('\nNo mislabeled bounces found. Nothing to do.');
    return;
  }

  console.table(list.map((c) => ({
    company: c.row.company ?? '—',
    sent_to: c.row.email_used ?? '—',
    type: c.type,
    msg_from: c.fromHdr ?? '(snippet)',
    msg_subject: c.subject ?? '',
    via: c.via,
  })));
  const hard = list.filter((c) => c.type === 'hard').length;
  console.log(`\n${list.length} mislabeled bounce(s): ${hard} hard / ${list.length - hard} soft (${snippetHits} via snippet fallback).`);

  if (!APPLY) {
    console.log('\nDRY-RUN — no changes written. Re-run with --apply to reclassify.');
    return;
  }

  console.log('\nApplying…');
  let done = 0;
  for (const c of list) if (await applyOne(c)) done++;
  console.log(`\nDone. Reclassified ${done}/${list.length} row(s) to 'bounced'.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[reclassify-bounces] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

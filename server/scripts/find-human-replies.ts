/**
 * One-off audit: re-classify every campaign_leads.status='replied' row by
 * pulling the actual inbound body from each sender account's IMAP inbox
 * and running it through the same auto-reply-detector the live trackers
 * use. The goal is to surface the rows that look like genuine human
 * responses (the rest are auto-replies / helpdesk ticket acks that
 * slipped past the live classifier).
 *
 * Usage (from /server):
 *   npx tsx scripts/find-human-replies.ts
 *   npx tsx scripts/find-human-replies.ts --include-auto   # also rescan auto_replied
 *   npx tsx scripts/find-human-replies.ts --csv > out.csv  # machine-readable
 */

import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getSupabase } from '../src/lib/supabase.js';
import { classifyReply } from '../src/services/auto-reply-detector.js';

const includeAuto = process.argv.includes('--include-auto');
const csvMode = process.argv.includes('--csv');

interface ImapAccount {
  email: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
}

interface ReplyRow {
  id: string;
  status: 'replied' | 'auto_replied';
  email_used: string | null;
  sender_email: string | null;
  replied_at: string | null;
  company: string | null;
}

interface VerdictRow extends ReplyRow {
  verdict: 'human' | 'auto' | 'ticket' | 'not_found' | 'error';
  confidence: number;
  signals: string[];
  subject: string;
  bodySnippet: string;
  fromHdr: string;
}

function log(...args: unknown[]): void {
  if (!csvMode) console.error(...args);
}

async function main(): Promise<void> {
  const supabase = getSupabase();

  // 1. Pull all rows we want to re-scan
  const statuses = includeAuto ? ['replied', 'auto_replied'] : ['replied'];
  const { data: rows, error } = await supabase
    .from('campaign_leads')
    .select('id, status, email_used, sender_email, replied_at, leads(company_name)')
    .in('status', statuses)
    .order('replied_at', { ascending: false });
  if (error) {
    console.error('Supabase query failed:', error);
    process.exit(1);
  }

  const replies: ReplyRow[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    status: r.status as 'replied' | 'auto_replied',
    email_used: r.email_used as string | null,
    sender_email: r.sender_email as string | null,
    replied_at: r.replied_at as string | null,
    company: ((r.leads as { company_name?: string } | null)?.company_name) ?? null,
  }));
  log(`Loaded ${replies.length} rows (statuses: ${statuses.join(', ')})`);

  // 2. Group by sender account
  const bySender = new Map<string, ReplyRow[]>();
  for (const r of replies) {
    if (!r.sender_email || !r.email_used) continue;
    const k = r.sender_email.toLowerCase();
    if (!bySender.has(k)) bySender.set(k, []);
    bySender.get(k)!.push(r);
  }
  log(`Sender accounts to scan: ${[...bySender.keys()].join(', ')}`);

  // 3. Pull IMAP credentials for each sender from email_accounts
  const { data: accountsData } = await supabase
    .from('email_accounts')
    .select('email, imap_host, imap_port, imap_user, imap_pass')
    .in('email', [...bySender.keys()])
    .not('imap_pass', 'is', null);
  const accounts: ImapAccount[] = (accountsData ?? []).map((a) => ({
    email: (a.email as string).toLowerCase(),
    imap_host: a.imap_host as string,
    imap_port: a.imap_port as number,
    imap_user: a.imap_user as string,
    imap_pass: a.imap_pass as string,
  }));

  const verdicts: VerdictRow[] = [];

  // 4. For each account, open one IMAP connection and search for inbound
  //    messages from every lead address we care about.
  for (const acc of accounts) {
    const targets = bySender.get(acc.email) ?? [];
    log(`\n[${acc.email}] scanning ${targets.length} targets via ${acc.imap_host}:${acc.imap_port}`);

    const client = new ImapFlow({
      host: acc.imap_host,
      port: acc.imap_port,
      secure: true,
      auth: { user: acc.imap_user, pass: acc.imap_pass },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });

    try {
      await client.connect();
      const mailboxes = await client.list();
      const inboxPath =
        mailboxes.find((b) => /^inbox$/i.test(b.name))?.path ?? 'INBOX';
      const allMailPath = mailboxes.find((b) => b.specialUse === '\\All')?.path;
      const scanPaths = [inboxPath, allMailPath].filter(Boolean) as string[];

      for (const row of targets) {
        const lead = (row.email_used ?? '').toLowerCase();
        if (!lead) continue;
        const repliedAt = row.replied_at ? new Date(row.replied_at) : null;
        const sinceDate = repliedAt
          ? new Date(repliedAt.getTime() - 2 * 24 * 60 * 60 * 1000)
          : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

        let found = false;
        for (const path of scanPaths) {
          if (found) break;
          const lock = await client.getMailboxLock(path);
          try {
            const uids = (await client.search({ from: lead, since: sinceDate })) || [];
            const list = Array.isArray(uids) ? uids : [];
            if (list.length === 0) continue;
            // Take the message closest in time to replied_at (or most recent if no replied_at)
            let best: { uid: number; date: Date; raw: Buffer } | null = null;
            for await (const msg of client.fetch(list, {
              envelope: true,
              uid: true,
              source: true,
            })) {
              if (!msg.source) continue;
              const d = msg.envelope?.date ?? new Date(0);
              const distance = repliedAt
                ? Math.abs(d.getTime() - repliedAt.getTime())
                : -d.getTime();
              if (!best || distance < Math.abs(best.date.getTime() - (repliedAt?.getTime() ?? 0))) {
                best = { uid: msg.uid!, date: d, raw: msg.source as Buffer };
              }
            }
            if (!best) continue;
            found = true;
            const parsed = await simpleParser(best.raw);
            const headersObj: Record<string, string | string[] | undefined> = {};
            parsed.headers.forEach((value, key) => {
              headersObj[key] = typeof value === 'string' ? value : (value as any)?.toString?.() ?? '';
            });
            const subject = parsed.subject ?? '';
            const bodyText = (parsed.text ?? parsed.html ?? '') as string;
            const verdict = classifyReply({ headers: headersObj, subject, body: bodyText });
            const snip = (parsed.text ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 240);
            const fromHdr =
              parsed.from?.value?.[0]?.address ??
              parsed.from?.text ??
              lead;
            verdicts.push({
              ...row,
              verdict: verdict.kind,
              confidence: verdict.confidence,
              signals: verdict.signals,
              subject,
              bodySnippet: snip,
              fromHdr,
            });
          } finally {
            lock.release();
          }
        }
        if (!found) {
          verdicts.push({
            ...row,
            verdict: 'not_found',
            confidence: 0,
            signals: [],
            subject: '',
            bodySnippet: '',
            fromHdr: lead,
          });
          log(`  not found: ${lead}`);
        }
      }
    } catch (e) {
      log(`[${acc.email}] IMAP error:`, e instanceof Error ? e.message : e);
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  }

  // 5. Sort: humans (low confidence) first, then by date desc
  verdicts.sort((a, b) => {
    const score = (v: VerdictRow): number => {
      if (v.verdict === 'human') return 0;
      if (v.verdict === 'auto') return 2;
      if (v.verdict === 'ticket') return 3;
      if (v.verdict === 'not_found') return 4;
      return 5;
    };
    const s = score(a) - score(b);
    if (s !== 0) return s;
    return (b.replied_at ?? '').localeCompare(a.replied_at ?? '');
  });

  // 6. Emit
  if (csvMode) {
    console.log(
      ['status_db', 'verdict', 'confidence', 'from', 'company', 'replied_at', 'subject', 'snippet', 'signals'].join('\t'),
    );
    for (const v of verdicts) {
      console.log(
        [
          v.status,
          v.verdict,
          v.confidence.toFixed(2),
          v.fromHdr,
          v.company ?? '',
          v.replied_at ?? '',
          (v.subject ?? '').replace(/\s+/g, ' ').slice(0, 80),
          v.bodySnippet.replace(/\s+/g, ' '),
          v.signals.join('|'),
        ].join('\t'),
      );
    }
    return;
  }

  const humans = verdicts.filter((v) => v.verdict === 'human');
  const autos = verdicts.filter((v) => v.verdict === 'auto' || v.verdict === 'ticket');
  const missing = verdicts.filter((v) => v.verdict === 'not_found' || v.verdict === 'error');

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  RE-CLASSIFICATION SUMMARY`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`  Total scanned:  ${verdicts.length}`);
  console.log(`  HUMAN replies:  ${humans.length}   ← look at these`);
  console.log(`  Auto/ticket:    ${autos.length}`);
  console.log(`  Not found:      ${missing.length}`);
  console.log();

  console.log(`──────── LIKELY HUMAN REPLIES (${humans.length}) ────────`);
  for (const v of humans) {
    console.log();
    console.log(`  status_db: ${v.status}   verdict: human (conf ${v.confidence.toFixed(2)})`);
    console.log(`  from:      ${v.fromHdr}`);
    console.log(`  company:   ${v.company ?? '—'}`);
    console.log(`  date:      ${v.replied_at ?? '—'}`);
    console.log(`  subject:   ${(v.subject ?? '').slice(0, 100)}`);
    console.log(`  snippet:   ${v.bodySnippet.slice(0, 220)}`);
  }

  console.log(`\n──────── AUTO / TICKET (${autos.length}) ────────`);
  for (const v of autos) {
    const sig = v.signals.slice(0, 3).join(',');
    console.log(
      `  ${v.verdict.padEnd(6)} ${v.confidence.toFixed(2)}  ${v.fromHdr.padEnd(40)} ${v.company ?? ''}  [${sig}]`,
    );
  }

  if (missing.length) {
    console.log(`\n──────── NOT FOUND (${missing.length}) ────────`);
    for (const v of missing) {
      console.log(`  ${v.fromHdr.padEnd(40)}  ${v.company ?? ''}  @ ${v.replied_at ?? ''}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

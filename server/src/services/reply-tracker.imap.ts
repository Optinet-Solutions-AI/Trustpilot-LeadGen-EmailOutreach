/**
 * IMAP reply tracker for SMTP/IMAP accounts (Bluehost Titan, DreamHost, etc.).
 *
 * Polls the account's INBOX for messages whose "From" matches a lead we sent
 * a campaign email FROM this same account. Gmail accounts use reply-tracker.ts
 * instead — this one covers every auth_type='smtp' account in email_accounts.
 *
 * Matching strategy (first hit wins):
 *   1. From: address equals the address we originally emailed
 *   2. In-Reply-To: header equals the Message-ID of our outgoing email
 *   3. References: chain contains the Message-ID of our outgoing email
 *
 * Strategies 2 + 3 catch replies routed through helpdesk/ticketing systems
 * (Zendesk, Helpscout, Freshdesk, etc.) where the visible "From" is a
 * ticket-specific address but the threading headers correctly point at the
 * original email.
 *
 * Scans messages from the last 7 days to keep fetch volume bounded.
 */

import { ImapFlow } from 'imapflow';
import { getSupabase } from '../lib/supabase.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';

export interface ImapAccount {
  id: string;
  email: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
}

type LeadRef = { id: string; lead_id: string; campaign_id: string };

function normalizeMessageId(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/^</, '').replace(/>$/, '').toLowerCase();
}

export async function checkRepliesImap(account: ImapAccount): Promise<{ repliesFound: number; scanned: number }> {
  const supabase = getSupabase();
  let repliesFound = 0;
  let scanned = 0;

  // Load every campaign_lead this account has sent to (and isn't already replied/bounced)
  const { data: sentLeads } = await supabase
    .from('campaign_leads')
    .select('id, lead_id, campaign_id, email_used, gmail_message_id')
    .eq('status', 'sent')
    .eq('sender_email', account.email);

  if (!sentLeads?.length) {
    console.log(`[ImapReplyTracker] ${account.email}: no sent-and-unreplied leads to watch`);
    return { repliesFound: 0, scanned: 0 };
  }

  // Two parallel lookup maps — From-address match and Message-ID threading.
  // Both keys point to the same lead refs so a matched lead can be removed
  // from both maps to prevent double-processing.
  const leadByEmail = new Map<string, LeadRef>();
  const leadByMessageId = new Map<string, LeadRef>();
  for (const l of sentLeads) {
    const ref: LeadRef = { id: l.id, lead_id: l.lead_id, campaign_id: l.campaign_id };
    if (l.email_used) leadByEmail.set(l.email_used.toLowerCase(), ref);
    const mid = normalizeMessageId(l.gmail_message_id);
    if (mid) leadByMessageId.set(mid, ref);
  }

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: { user: account.imap_user, pass: account.imap_pass },
    logger: false,
    connectionTimeout: 15000,
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;

    const lock = await client.getMailboxLock('INBOX');
    try {
      // Only scan messages from the last 7 days — bounded fetch volume
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since });
      if (!uids || uids.length === 0) {
        return { repliesFound: 0, scanned: 0 };
      }

      // Helper: drop a matched lead from BOTH lookup maps so the same campaign_lead
      // can't be flipped twice within one poll (e.g. a thread that hits both
      // From-address and Message-ID strategies).
      const dropLead = (ref: LeadRef) => {
        for (const [k, v] of leadByEmail) if (v.id === ref.id) leadByEmail.delete(k);
        for (const [k, v] of leadByMessageId) if (v.id === ref.id) leadByMessageId.delete(k);
      };

      const markReplied = async (
        lead: LeadRef,
        opts: { fromAddr: string; subject: string; matchedBy: 'from' | 'in-reply-to' | 'references' },
      ): Promise<boolean> => {
        const { error: updateErr } = await supabase
          .from('campaign_leads')
          .update({ status: 'replied', replied_at: new Date().toISOString() })
          .eq('id', lead.id)
          .eq('status', 'sent');
        if (updateErr) return false;

        await updateLead(lead.lead_id, { outreach_status: 'replied' });
        await createNote(lead.lead_id, {
          type: 'email_replied',
          content: `Reply received via IMAP (${account.email}, matched by ${opts.matchedBy})`,
          metadata: { campaign_id: lead.campaign_id, from: opts.fromAddr, subject: opts.subject, matched_by: opts.matchedBy },
        });

        const { data: campaign } = await supabase
          .from('campaigns').select('total_replied').eq('id', lead.campaign_id).single();
        if (campaign) {
          await supabase
            .from('campaigns')
            .update({ total_replied: (campaign.total_replied || 0) + 1 })
            .eq('id', lead.campaign_id);
        }

        console.log(`[ImapReplyTracker] ${account.email}: reply from ${opts.fromAddr} (${opts.matchedBy}) → campaign_lead ${lead.id}`);
        dropLead(lead);
        return true;
      };

      // Fetch envelope (From, Subject, Message-ID, In-Reply-To) plus raw References header.
      // References isn't on the envelope so we ask for it explicitly.
      for await (const msg of client.fetch(uids, { envelope: true, uid: true, headers: ['references'] })) {
        scanned++;

        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';
        const subject  = msg.envelope?.subject ?? '';

        // Strategy 1 — From-address match
        if (fromAddr) {
          const lead = leadByEmail.get(fromAddr);
          if (lead) {
            const ok = await markReplied(lead, { fromAddr, subject, matchedBy: 'from' });
            if (ok) repliesFound++;
            continue;
          }
        }

        // Strategy 2 — In-Reply-To header points at one of our outgoing Message-IDs
        const irt = normalizeMessageId(msg.envelope?.inReplyTo);
        if (irt) {
          const lead = leadByMessageId.get(irt);
          if (lead) {
            const ok = await markReplied(lead, { fromAddr: fromAddr || '(unknown)', subject, matchedBy: 'in-reply-to' });
            if (ok) repliesFound++;
            continue;
          }
        }

        // Strategy 3 — References chain contains one of our outgoing Message-IDs
        const refsHeader = msg.headers?.toString('utf8') ?? '';
        if (refsHeader) {
          // Extract every <id@domain> token from the References header
          const refs = refsHeader.match(/<[^<>]+>/g) ?? [];
          for (const ref of refs) {
            const lead = leadByMessageId.get(normalizeMessageId(ref));
            if (lead) {
              const ok = await markReplied(lead, { fromAddr: fromAddr || '(unknown)', subject, matchedBy: 'references' });
              if (ok) repliesFound++;
              break;
            }
          }
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`[ImapReplyTracker] ${account.email} error:`, err instanceof Error ? err.message : err);
  } finally {
    if (connected) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }

  return { repliesFound, scanned };
}

/** Poll every active SMTP account that has IMAP credentials. */
export async function checkAllImapReplies(): Promise<{ accountsChecked: number; repliesFound: number }> {
  const supabase = getSupabase();
  const { data: accounts } = await supabase
    .from('email_accounts')
    .select('id, email, imap_host, imap_port, imap_user, imap_pass')
    .eq('auth_type', 'smtp')
    .eq('status', 'active')
    .not('imap_host', 'is', null)
    .not('imap_user', 'is', null)
    .not('imap_pass', 'is', null);

  if (!accounts?.length) return { accountsChecked: 0, repliesFound: 0 };

  let total = 0;
  for (const acc of accounts) {
    const result = await checkRepliesImap({
      id: acc.id,
      email: acc.email,
      imap_host: acc.imap_host,
      imap_port: acc.imap_port ?? 993,
      imap_user: acc.imap_user,
      imap_pass: acc.imap_pass,
    });
    total += result.repliesFound;
  }
  return { accountsChecked: accounts.length, repliesFound: total };
}

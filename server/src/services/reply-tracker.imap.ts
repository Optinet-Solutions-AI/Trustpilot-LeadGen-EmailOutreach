/**
 * IMAP reply tracker for SMTP/IMAP accounts (Bluehost Titan, DreamHost, etc.).
 *
 * Polls the account's INBOX for messages whose "From" matches a lead we sent
 * a campaign email FROM this same account. Gmail accounts use reply-tracker.ts
 * instead — this one covers every auth_type='smtp' account in email_accounts.
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

export async function checkRepliesImap(account: ImapAccount): Promise<{ repliesFound: number; scanned: number }> {
  const supabase = getSupabase();
  let repliesFound = 0;
  let scanned = 0;

  // Load every campaign_lead this account has sent to (and isn't already replied/bounced)
  const { data: sentLeads } = await supabase
    .from('campaign_leads')
    .select('id, lead_id, campaign_id, email_used')
    .eq('status', 'sent')
    .eq('sender_email', account.email);

  if (!sentLeads?.length) {
    console.log(`[ImapReplyTracker] ${account.email}: no sent-and-unreplied leads to watch`);
    return { repliesFound: 0, scanned: 0 };
  }

  // Map recipient address (lowercased) → campaign_lead row so we can look up
  // matches in O(1) while iterating INBOX messages.
  const leadByEmail = new Map<string, { id: string; lead_id: string; campaign_id: string }>();
  for (const l of sentLeads) {
    if (l.email_used) leadByEmail.set(l.email_used.toLowerCase(), {
      id: l.id, lead_id: l.lead_id, campaign_id: l.campaign_id,
    });
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

      for await (const msg of client.fetch(uids, { envelope: true, uid: true })) {
        scanned++;
        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';
        if (!fromAddr) continue;

        const lead = leadByEmail.get(fromAddr);
        if (!lead) continue;

        // Prevent double-processing if we pick up the same reply on a later poll.
        // Clearing from the map means repeated replies from the same address
        // only flip the status once per tracker run.
        leadByEmail.delete(fromAddr);

        const { error: updateErr } = await supabase
          .from('campaign_leads')
          .update({ status: 'replied', replied_at: new Date().toISOString() })
          .eq('id', lead.id)
          .eq('status', 'sent');
        if (updateErr) continue;

        await updateLead(lead.lead_id, { outreach_status: 'replied' });
        await createNote(lead.lead_id, {
          type: 'email_replied',
          content: `Reply received via IMAP (${account.email})`,
          metadata: { campaign_id: lead.campaign_id, from: fromAddr, subject: msg.envelope?.subject ?? '' },
        });

        const { data: campaign } = await supabase
          .from('campaigns').select('total_replied').eq('id', lead.campaign_id).single();
        if (campaign) {
          await supabase
            .from('campaigns')
            .update({ total_replied: (campaign.total_replied || 0) + 1 })
            .eq('id', lead.campaign_id);
        }

        repliesFound++;
        console.log(`[ImapReplyTracker] ${account.email}: reply from ${fromAddr} → campaign_lead ${lead.id}`);
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

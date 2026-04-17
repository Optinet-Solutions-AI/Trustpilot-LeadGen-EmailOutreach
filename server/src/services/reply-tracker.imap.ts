/**
 * IMAP reply tracker.
 * Polls the INBOX of SMTP/IMAP accounts (e.g. DreamHost) for replies
 * to sent campaign emails.
 * DreamHost uses port 993 with TLS (secure: true).
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

export async function checkRepliesImap(account: ImapAccount): Promise<{ repliesFound: number }> {
  const supabase = getSupabase();
  let repliesFound = 0;

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: {
      user: account.imap_user,
      pass: account.imap_pass,
    },
    logger: false,
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;

    // Get sent campaign leads for this account that haven't been marked replied
    const { data: sentLeads, error } = await supabase
      .from('campaign_leads')
      .select('id, lead_id, campaign_id, email_used')
      .eq('status', 'sent')
      .eq('email_used', account.email);

    if (error || !sentLeads?.length) return { repliesFound: 0 };

    const leadEmails = new Set(sentLeads.map((l) => l.email_used?.toLowerCase()));

    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const msg of client.fetch('1:*', { envelope: true })) {
        const toAddr = msg.envelope?.to?.[0]?.address?.toLowerCase() ?? '';
        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';

        if (!leadEmails.has(toAddr)) continue;

        const lead = sentLeads.find((l) => l.email_used?.toLowerCase() === toAddr);
        if (!lead) continue;

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
          metadata: { campaign_id: lead.campaign_id, from: fromAddr },
        });

        // Increment campaign total_replied
        const { data: campaign } = await supabase
          .from('campaigns')
          .select('total_replied')
          .eq('id', lead.campaign_id)
          .single();
        if (campaign) {
          await supabase
            .from('campaigns')
            .update({ total_replied: (campaign.total_replied || 0) + 1 })
            .eq('id', lead.campaign_id);
        }

        repliesFound++;
        console.log(`[ImapReplyTracker] Reply for lead ${lead.lead_id} from ${fromAddr}`);
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`[ImapReplyTracker] Error for ${account.email}:`, err instanceof Error ? err.message : err);
  } finally {
    // Always close the connection — never leave a zombie IMAP socket open.
    if (connected) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }

  return { repliesFound };
}

/**
 * Gmail reply tracker.
 * Polls Gmail threads for replies to sent campaign emails.
 * Updates lead status and campaign counts when replies are detected.
 *
 * Only active when EMAIL_MODE=gmail
 */

import { getGmailClient } from './gmail-client.js';
import { getSupabase } from '../lib/supabase.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { config } from '../config.js';

interface SentCampaignLead {
  id: string;
  lead_id: string;
  campaign_id: string;
  gmail_thread_id: string;
  gmail_message_id: string;
  replied_at: string | null;
}

export async function checkForReplies(): Promise<{ repliesFound: number }> {
  if (config.emailMode !== 'gmail') return { repliesFound: 0 };

  const supabase = getSupabase();
  let repliesFound = 0;

  try {
    const gmail = getGmailClient();

    // Get all sent campaign leads that have a thread ID and haven't been marked as replied
    const { data: sentLeads, error } = await supabase
      .from('campaign_leads')
      .select('id, lead_id, campaign_id, gmail_thread_id, gmail_message_id, replied_at')
      .eq('status', 'sent')
      .not('gmail_thread_id', 'is', null);

    if (error) {
      console.error('[ReplyTracker] DB query error:', error.message);
      return { repliesFound: 0 };
    }

    if (!sentLeads || sentLeads.length === 0) return { repliesFound: 0 };

    const fromEmail = config.gmail.fromEmail.toLowerCase();

    for (const cl of sentLeads as SentCampaignLead[]) {
      try {
        // Fetch the full thread
        const threadRes = await gmail.users.threads.get({
          userId: 'me',
          id: cl.gmail_thread_id,
          format: 'metadata',
          metadataHeaders: ['From', 'Date'],
        });

        const messages = threadRes.data.messages || [];

        // If the thread has more than 1 message, check if the extra messages are from someone else
        if (messages.length <= 1) continue;

        // Find any message that's NOT from our sender address
        const hasReply = messages.some((msg) => {
          const fromHeader = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === 'from');
          const from = fromHeader?.value?.toLowerCase() || '';
          return !from.includes(fromEmail);
        });

        if (!hasReply) continue;

        // Get the reply message snippet for the note
        const replyMsg = messages.find((msg) => {
          const fromHeader = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === 'from');
          const from = fromHeader?.value?.toLowerCase() || '';
          return !from.includes(fromEmail);
        });
        const snippet = replyMsg?.snippet || '';

        // Update campaign_leads status
        await supabase
          .from('campaign_leads')
          .update({ status: 'replied', replied_at: new Date().toISOString() })
          .eq('id', cl.id);

        // Update lead outreach status
        await updateLead(cl.lead_id, { outreach_status: 'replied' });

        // Create activity note
        await createNote(cl.lead_id, {
          type: 'email_replied',
          content: `Reply received via Gmail`,
          metadata: {
            campaign_id: cl.campaign_id,
            gmail_thread_id: cl.gmail_thread_id,
            snippet: snippet.slice(0, 200),
          },
        });

        // Increment campaign total_replied
        const { data: campaign } = await supabase
          .from('campaigns')
          .select('total_replied')
          .eq('id', cl.campaign_id)
          .single();
        if (campaign) {
          await supabase
            .from('campaigns')
            .update({ total_replied: (campaign.total_replied || 0) + 1 })
            .eq('id', cl.campaign_id);
        }

        repliesFound++;
        console.log(`[ReplyTracker] Reply found for lead ${cl.lead_id} in campaign ${cl.campaign_id}`);

      } catch (threadErr) {
        const msg = threadErr instanceof Error ? threadErr.message : String(threadErr);
        // 404 = thread deleted; skip silently
        if (!msg.includes('404')) {
          console.warn(`[ReplyTracker] Error checking thread ${cl.gmail_thread_id}:`, msg);
        }
      }
    }
  } catch (err) {
    console.error('[ReplyTracker] Fatal error:', err instanceof Error ? err.message : err);
  }

  return { repliesFound };
}

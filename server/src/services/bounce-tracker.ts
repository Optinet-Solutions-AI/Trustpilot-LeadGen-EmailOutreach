/**
 * Gmail bounce tracker.
 *
 * Scans all connected Gmail sending accounts for unread delivery failure
 * notifications from the Mail Delivery Subsystem (mailer-daemon).
 *
 * On each run:
 *  1. Fetch unread messages matching the bounce query from each sender account
 *  2. Extract the bounced email address from the message body/snippet
 *  3. Cross-reference with campaign_leads.email_used
 *  4. Mark the lead as 'bounced' in campaign_leads
 *  5. For hard bounces: mark lead email as invalid (email_verified=false, verification_status='invalid')
 *  6. Create an activity note for the lead timeline
 *  7. Mark the bounce notification as read so it's not reprocessed
 *
 * Only active when EMAIL_MODE=gmail.
 * Runs every 5 minutes (every 5 ticks of the 60s campaign-scheduler loop).
 */

import { getGmailClient, createGmailClientFromCredentials } from './gmail-client.js';
import { getSupabase } from '../lib/supabase.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { config } from '../config.js';

// Only look at unread bounce messages from the last 30 days
const BOUNCE_QUERY = 'from:mailer-daemon is:unread newer_than:30d';

// Hard bounce: permanent failure — the address is definitely invalid
const HARD_BOUNCE_PATTERNS = [
  /550[\s\-]/,       // 550 5.1.1 — user unknown / address not found
  /551[\s\-]/,       // 551 — user not local
  /552[\s\-]/,       // 552 — exceeded storage allocation (sometimes permanent)
  /553[\s\-]/,       // 553 — mailbox name invalid
  /554[\s\-]/,       // 554 — transaction failed permanently
  /5\.1\.1/,         // 5.1.1 — bad destination mailbox address
  /5\.1\.2/,         // 5.1.2 — bad destination system
  /5\.1\.3/,         // 5.1.3 — bad destination mailbox address syntax
  /NoSuchUser/i,
  /user unknown/i,
  /user does not exist/i,
  /address.*not found/i,
  /invalid.*address/i,
  /no such.*mailbox/i,
  /recipient.*rejected/i,
  /account.*does not exist/i,
  /mailbox not found/i,
];

// Soft bounce: temporary failure — may succeed on retry
const SOFT_BOUNCE_PATTERNS = [
  /452[\s\-]/,       // 452 — insufficient system storage
  /421[\s\-]/,       // 421 — service temporarily unavailable
  /4\.\d\.\d/,       // any 4xx DSN code
  /temporarily/i,
  /try again/i,
  /quota exceeded/i,
  /over.*limit/i,
  /mailbox.*full/i,
];

/** Extract the bounced recipient address from a DSN message body or snippet. */
function extractBouncedEmail(text: string): string | null {
  const patterns = [
    // Google's phrasing: "Your message wasn't delivered to john@example.com"
    /wasn't delivered to\s+([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i,
    // RFC 3464 MIME DSN: "Final-Recipient: rfc822; john@example.com"
    /Final-Recipient:\s*rfc822;\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i,
    // "delivery to the following recipient failed permanently: john@example.com"
    /recipient.*?failed.*?:\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i,
    // "failed to deliver to john@example.com"
    /failed to deliver.*?to\s+([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i,
    // Generic SMTP log line: "<john@example.com>" or "to=<john@example.com>"
    /to=<([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}

function classifyBounce(text: string): 'hard' | 'soft' {
  if (HARD_BOUNCE_PATTERNS.some(p => p.test(text))) return 'hard';
  if (SOFT_BOUNCE_PATTERNS.some(p => p.test(text))) return 'soft';
  // Default to hard for unrecognised 5xx failures from mailer-daemon
  return 'hard';
}

interface GmailClientEntry {
  email: string;
  gmail: ReturnType<typeof getGmailClient>;
}

/** Build a list of Gmail clients for all active sending accounts. */
async function getAllSenderGmailClients(): Promise<GmailClientEntry[]> {
  const clients: GmailClientEntry[] = [];

  // Primary env account
  try {
    clients.push({ email: config.gmail.fromEmail.toLowerCase(), gmail: getGmailClient() });
  } catch {
    // Env account not configured — skip
  }

  // Connected DB accounts
  try {
    const { data: dbAccounts } = await getSupabase()
      .from('email_accounts')
      .select('email, gmail_client_id, gmail_client_secret, gmail_refresh_token')
      .eq('status', 'active')
      .eq('auth_type', 'gmail_oauth')
      .not('gmail_refresh_token', 'is', null);

    for (const acc of dbAccounts ?? []) {
      if (!acc.gmail_client_id || !acc.gmail_client_secret || !acc.gmail_refresh_token) continue;
      const email = (acc.email as string).toLowerCase();
      // Avoid duplicate if DB account is same as env account
      if (clients.some(c => c.email === email)) continue;
      clients.push({
        email,
        gmail: createGmailClientFromCredentials(
          acc.gmail_client_id, acc.gmail_client_secret, acc.gmail_refresh_token
        ),
      });
    }
  } catch {
    // DB unavailable — continue with env account only
  }

  return clients;
}

/** Extract plain text from a Gmail message payload (handles multipart). */
function extractBodyText(payload: any): string {
  if (!payload) return '';

  // Direct body (non-multipart)
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  // Multipart: walk parts looking for text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
      // Nested multipart
      if (part.parts) {
        const nested = extractBodyText(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

export async function checkForBounces(): Promise<{ bouncesFound: number }> {
  if (config.emailMode !== 'gmail') return { bouncesFound: 0 };

  let bouncesFound = 0;
  const supabase = getSupabase();
  const senderClients = await getAllSenderGmailClients();

  for (const { email: senderEmail, gmail } of senderClients) {
    try {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: BOUNCE_QUERY,
        maxResults: 50,
      });

      const messages = listRes.data.messages ?? [];
      if (messages.length === 0) continue;

      console.log(`[BounceTracker] ${messages.length} unread bounce notification(s) in ${senderEmail}`);

      for (const msgRef of messages) {
        if (!msgRef.id) continue;

        try {
          // Fetch full message for body parsing
          const msgRes = await gmail.users.messages.get({
            userId: 'me',
            id: msgRef.id,
            format: 'full',
          });

          const msg = msgRes.data;
          const snippet = msg.snippet ?? '';
          const bodyText = extractBodyText(msg.payload);
          const fullText = snippet + '\n' + bodyText;

          // Extract the bounced email address
          const bouncedEmail = extractBouncedEmail(fullText);

          if (!bouncedEmail) {
            console.warn(`[BounceTracker] Could not extract email from bounce message ${msgRef.id} — snippet: ${snippet.slice(0, 80)}`);
            // Mark as read so we don't retry indefinitely
            await markRead(gmail, msgRef.id);
            continue;
          }

          // Skip if the bounced address is our own sending account (self-bounce edge case)
          if (bouncedEmail === senderEmail) {
            await markRead(gmail, msgRef.id);
            continue;
          }

          const bounceType = classifyBounce(fullText);

          // Find all campaign_leads that used this email and are still in an active state
          const { data: campaignLeads } = await supabase
            .from('campaign_leads')
            .select('id, lead_id, campaign_id, status')
            .eq('email_used', bouncedEmail)
            .in('status', ['pending', 'sent', 'opened']);

          if (!campaignLeads || campaignLeads.length === 0) {
            // No matching campaign lead — still mark as read
            await markRead(gmail, msgRef.id);
            continue;
          }

          console.log(`[BounceTracker] ${bounceType} bounce → ${bouncedEmail} (${campaignLeads.length} record(s))`);

          const leadIds = new Set<string>();

          for (const cl of campaignLeads as { id: string; lead_id: string; campaign_id: string; status: string }[]) {
            // Update campaign_lead status to bounced
            await supabase
              .from('campaign_leads')
              .update({ status: 'bounced' })
              .eq('id', cl.id);

            // Update campaign total_bounced counter (read-increment-write)
            const { data: campaign } = await supabase
              .from('campaigns')
              .select('total_bounced')
              .eq('id', cl.campaign_id)
              .single();
            if (campaign) {
              await supabase
                .from('campaigns')
                .update({ total_bounced: (campaign.total_bounced || 0) + 1 })
                .eq('id', cl.campaign_id);
            }

            // Create activity note (once per lead, not once per campaign_lead row)
            if (!leadIds.has(cl.lead_id)) {
              leadIds.add(cl.lead_id);

              await createNote(cl.lead_id, {
                type: 'email_bounced',
                content: `Email bounced (${bounceType} bounce) — ${bouncedEmail}`,
                metadata: {
                  campaign_id: cl.campaign_id,
                  bounce_type: bounceType,
                  sender_account: senderEmail,
                },
              });

              // Hard bounce: permanently mark lead email as invalid so it's excluded from future campaigns
              if (bounceType === 'hard') {
                await updateLead(cl.lead_id, {
                  email_verified: false,
                  verification_status: 'invalid',
                });
              }
            }

            bouncesFound++;
          }

          // Mark the bounce notification as read (processed)
          await markRead(gmail, msgRef.id);

        } catch (msgErr) {
          const errMsg = msgErr instanceof Error ? msgErr.message : String(msgErr);
          console.warn(`[BounceTracker] Error processing message ${msgRef.id}:`, errMsg);
        }
      }

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[BounceTracker] Error checking account ${senderEmail}:`, errMsg);
    }
  }

  if (bouncesFound > 0) {
    console.log(`[BounceTracker] Marked ${bouncesFound} campaign lead(s) as bounced`);
  }

  return { bouncesFound };
}

async function markRead(gmail: GmailClientEntry['gmail'], messageId: string): Promise<void> {
  try {
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
  } catch {
    // Non-fatal — worst case we reprocess on the next run
  }
}

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

// Sender-side throttle / refusal — the SENDING account was blocked, the
// recipient was never the problem. These look like hard bounces (they carry a
// 5xx / dotted DSN code) but mean "your account is rate/bounce/quota limited,
// retry later", NOT "dead address". They MUST be classified transient so the
// schedulers retry after the window resets instead of marking the lead bounced
// and killing the sequence.
//
// Root case (2026-06-29): Titan/OpenSRS rejected a send from
// james@optiratesolutions.net with "550 5.4.6 Sender Hourly Bounce Limit
// Exceeded ... will not be allowed to send emails till ...", which the old
// 550/5.x.x hard-bounce match flagged as a permanent recipient bounce.
//
// Kept tight on purpose — every phrase here unambiguously references the
// SENDER's account (bounce/sending/rate limit, "will not be allowed to send",
// throttled). A real recipient bounce never uses this language, so we won't
// turn a genuinely dead address into an infinite retry.
const SENDER_THROTTLE_PATTERNS = [
  /bounce limit/i,                          // "Sender Hourly Bounce Limit Exceeded" (Titan/OpenSRS)
  /will not be allowed to send/i,           // Titan throttle phrasing
  /sender[^.\n]{0,40}limit/i,               // "Sender Hourly … Limit"
  /(hourly|daily|sending|message)[^.\n]{0,20}limit\s+(is\s+)?(exceeded|reached)/i,
  /sending limit/i,
  /rate[\s\-]?limit/i,                      // generic provider rate-limit refusal
  /throttl/i,                               // throttled / throttling
  /sending quota/i,
  /too many (messages|emails|recipients|connections)/i,
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

/**
 * True when an SMTP/Gmail send-error string indicates a PERMANENT failure —
 * the recipient mailbox doesn't exist or was rejected outright (550, 5.1.1,
 * "user unknown", "recipient rejected", ...). Lets the schedulers stop a lead
 * at send time instead of waiting for an async mailer-daemon bounce that may
 * never arrive for synchronously-rejected SMTP sends. A `false` here means the
 * error was transient (4xx / network) and the send may succeed on retry.
 */
export function isPermanentSendFailure(errorText: string | undefined | null): boolean {
  if (!errorText) return false;
  // Sender-side throttles come first — they carry 5xx codes that would
  // otherwise match HARD_BOUNCE_PATTERNS, but they mean "retry later", not
  // "dead recipient". Returning false here keeps the schedulers retrying the
  // send instead of marking the lead bounced and stopping the sequence.
  if (SENDER_THROTTLE_PATTERNS.some(p => p.test(errorText))) return false;
  if (SOFT_BOUNCE_PATTERNS.some(p => p.test(errorText))) return false;
  return HARD_BOUNCE_PATTERNS.some(p => p.test(errorText));
}

// A delivery-status notification (NDR) sender. Address is mailer-daemon /
// postmaster regardless of the "Mail Delivery Subsystem" display name.
const DAEMON_FROM = /(mailer-daemon|postmaster|mail\s*delivery\s*(sub)?system)/i;

// Subjects MTAs put on bounces. Kept broad — different providers phrase the
// same failure a dozen ways ("Undelivered Mail Returned to Sender", "Mail
// delivery failed", "Delivery Status Notification (Failure)", ...).
const NDR_SUBJECT = /(delivery\s+status\s+notification|undeliverable|undelivered\s+mail|mail\s+delivery\s+(failed|failure|subsystem)|returned\s+mail|delivery\s+(has\s+)?failed|failure\s+notice|message\s+(was\s+not|not|could\s+not\s+be)\s+delivered|address\s+not\s+found)/i;

function pickHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    return Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return '';
}

/**
 * Classify an INBOUND message as a delivery-status notification (bounce/NDR).
 *
 * A bounce threads under our original outgoing Message-ID (the NDR quotes the
 * failed message), so the IMAP reply tracker's References-match strategy picks
 * it up as if it were a reply. Without this guard, a hard bounce gets counted
 * as a human reply — inflating reply rate and leaving the dead address active.
 *
 * Detection layers four independent signals; any one is sufficient:
 *   1. From address is mailer-daemon / postmaster
 *   2. Content-Type is multipart/report; report-type=delivery-status (RFC 3464)
 *   3. Subject matches a known NDR phrasing
 *   4. Body carries an RFC 3464 DSN block with Action: failed
 *
 * Pure function — no IO. Reuses the existing extractBouncedEmail / classifyBounce
 * so hard-vs-soft logic stays in one place.
 */
export function classifyInboundBounce(input: {
  fromAddr?: string | null;
  subject?: string | null;
  headers?: Record<string, string | string[] | undefined>;
  body?: string | null;
}): { isBounce: boolean; type: 'hard' | 'soft'; bouncedEmail: string | null } {
  const from = (input.fromAddr || '').toLowerCase();
  const subject = input.subject || '';
  const body = input.body || '';
  const contentType = pickHeaderValue(input.headers, 'content-type');

  const fromDaemon = DAEMON_FROM.test(from);
  const isReport =
    /multipart\/report/i.test(contentType) &&
    /report-type\s*=\s*["']?delivery-status/i.test(contentType);
  const subjectNdr = NDR_SUBJECT.test(subject);
  const dsnBlock =
    /^\s*final-recipient\s*:/im.test(body) && /^\s*action\s*:\s*failed/im.test(body);

  if (!(fromDaemon || isReport || subjectNdr || dsnBlock)) {
    return { isBounce: false, type: 'hard', bouncedEmail: null };
  }

  const scanText = `${subject}\n${body}`;
  return {
    isBounce: true,
    type: classifyBounce(scanText),
    bouncedEmail: extractBouncedEmail(scanText),
  };
}

// Snippet-safe hard-failure signals. Deliberately EXCLUDES the bare 3-digit
// SMTP codes (550/551/…) that HARD_BOUNCE_PATTERNS carries: in a real DSN a
// lone "550 " is reliable, but in free-form reply text it collides with
// everyday numbers ("we're at 550 King St"). These are unambiguous in prose —
// dotted DSN codes and named refusal phrases a human reply would never use.
const SNIPPET_HARD_SIGNALS = [
  /5\.\d\.\d/,                 // dotted enhanced status code, e.g. 5.1.1
  /NoSuchUser/i,
  /user unknown/i,
  /user does not exist/i,
  /address.*not found/i,
  /no such.*mailbox/i,
  /mailbox not found/i,
  /recipient.*rejected/i,
  /account.*does not exist/i,
];

/**
 * Classify a stored `campaign_leads.reply_snippet` (body text only) as a
 * bounce. Used by the one-off backfill that reclassifies rows the live tracker
 * marked 'replied' before the bounce guard shipped (commit b9cc8fc) — those
 * rows have no preserved From/Subject/headers, only the body the tracker saved.
 *
 * Two layers, conservative by design (a backfill must not flip genuine human
 * replies):
 *   1. Run the inbound NDR detector with the snippet as both subject + body so
 *      its subject-phrasing and RFC 3464 DSN-block signals can fire.
 *   2. Fall back to snippet-safe hard-failure phrases ("NoSuchUser",
 *      "account … does not exist", dotted 5.x.x codes) for NDRs whose body
 *      carries the refusal text without standard NDR subject phrasing.
 *
 * Only PERMANENT failures are flagged. A transient/soft snippet (4xx, mailbox
 * full) returns isBounce=false — a mislabeled transient failure is rare and
 * not worth the false-positive risk on a bulk reclassify.
 */
export function classifyBounceFromSnippet(
  snippet: string | null | undefined,
  fallbackEmail?: string | null,
): { isBounce: boolean; type: 'hard' | 'soft'; bouncedEmail: string | null } {
  const text = (snippet || '').trim();
  if (!text) return { isBounce: false, type: 'hard', bouncedEmail: null };

  const inbound = classifyInboundBounce({ subject: text, body: text });
  if (inbound.isBounce) {
    return {
      isBounce: true,
      type: inbound.type,
      bouncedEmail: inbound.bouncedEmail ?? fallbackEmail ?? null,
    };
  }

  if (SNIPPET_HARD_SIGNALS.some(p => p.test(text))) {
    return {
      isBounce: true,
      type: 'hard',
      bouncedEmail: extractBouncedEmail(text) ?? fallbackEmail ?? null,
    };
  }

  return { isBounce: false, type: 'hard', bouncedEmail: null };
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

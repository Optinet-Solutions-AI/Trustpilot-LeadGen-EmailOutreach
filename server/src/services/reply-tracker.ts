/**
 * Gmail reply tracker.
 * Polls Gmail threads for replies to sent campaign emails.
 * Updates lead status and campaign counts when replies are detected.
 *
 * Only active when EMAIL_MODE=gmail.
 *
 * Auto-reply handling (gated on config.autoReplyHandlingEnabled):
 *   - Replies classified as 'auto' or 'ticket' flip status='auto_replied'
 *     instead of 'replied'. Reply-rate metrics stay human-only.
 *   - The classifier feeds the auto-reply-extractor, which pulls candidate
 *     emails / URLs that get persisted to discovered_contacts for review.
 *   - Pre-gate: when extractor returns no candidates, the lead drops out of
 *     the discovery pipeline entirely (only an audit note is written) so we
 *     don't burn verifier credits or scrape time on empty auto-acks.
 *   - Feature-flag-off: status stays 'replied' (legacy) but a shadow note
 *     'auto_reply_candidate' is also written for offline precision scoring.
 */

import { getGmailClient } from './gmail-client.js';
import { getSupabase } from '../lib/supabase.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { config } from '../config.js';
import { classifyReply, detectOptOut } from './auto-reply-detector.js';
import { classifyInboundBounce } from './bounce-tracker.js';
import { extractContacts } from './auto-reply-extractor.js';
import { insertDiscoveredContact } from '../db/discovered-contacts.js';

// Gmail's message payload uses a recursive part tree. These types model the
// pieces we read; the full type from googleapis is much larger.
interface GmailHeader { name?: string | null; value?: string | null }
interface GmailPart {
  mimeType?: string | null;
  headers?: GmailHeader[] | null;
  body?: { data?: string | null; size?: number | null; attachmentId?: string | null } | null;
  parts?: GmailPart[] | null;
}

interface GmailMessage {
  id?: string | null;
  snippet?: string | null;
  payload?: GmailPart | null;
}

interface SentCampaignLead {
  id: string;
  lead_id: string;
  campaign_id: string;
  email_used: string | null;
  gmail_thread_id: string;
  gmail_message_id: string;
  replied_at: string | null;
}

export async function checkForReplies(): Promise<{ repliesFound: number; autoRepliesFound: number; bouncesFound: number }> {
  if (config.emailMode !== 'gmail') return { repliesFound: 0, autoRepliesFound: 0, bouncesFound: 0 };

  const supabase = getSupabase();
  let repliesFound = 0;
  let autoRepliesFound = 0;
  let bouncesFound = 0;

  try {
    const gmail = getGmailClient();

    const { data: sentLeads, error } = await supabase
      .from('campaign_leads')
      .select('id, lead_id, campaign_id, email_used, gmail_thread_id, gmail_message_id, replied_at')
      .eq('status', 'sent')
      .not('gmail_thread_id', 'is', null);

    if (error) {
      console.error('[ReplyTracker] DB query error:', error.message);
      return { repliesFound: 0, autoRepliesFound: 0, bouncesFound: 0 };
    }

    if (!sentLeads || sentLeads.length === 0) return { repliesFound: 0, autoRepliesFound: 0, bouncesFound: 0 };

    const fromEmail = config.gmail.fromEmail.toLowerCase();

    for (const cl of sentLeads as SentCampaignLead[]) {
      try {
        // Fetch the full thread (format='full' so we get headers + bodies).
        // Previously we only fetched 'metadata' which excluded the body — the
        // auto-reply detector and extractor both need the message content.
        const threadRes = await gmail.users.threads.get({
          userId: 'me',
          id: cl.gmail_thread_id,
          format: 'full',
        });

        const messages = (threadRes.data.messages ?? []) as GmailMessage[];
        if (messages.length <= 1) continue;

        // The reply is any message NOT from our sender address. If multiple
        // exist (long conversation) take the first inbound — that's the one
        // whose classification matters for the status flip.
        const replyMsg = messages.find((msg) => {
          const fromHeader = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === 'from');
          const from = fromHeader?.value?.toLowerCase() || '';
          return !from.includes(fromEmail);
        });
        if (!replyMsg) continue;

        const headers = headersToMap(replyMsg.payload?.headers ?? []);
        const subject = pickHeader(headers, 'subject');
        const fromAddr = pickHeader(headers, 'from');
        const body = extractBodyText(replyMsg.payload ?? null) || replyMsg.snippet || '';
        const snippet = (replyMsg.snippet ?? '').slice(0, 200);

        // Bounce/NDR guard — MUST run before classifyReply. A Mail Delivery
        // Subsystem report threads under our outgoing Message-ID, so Gmail
        // groups it into the campaign thread and it surfaces here as the
        // inbound message. Without this it'd be counted as a human reply.
        // Mirrors the IMAP path's guard (reply-tracker.imap.ts).
        const bounce = classifyInboundBounce({ fromAddr, subject, headers, body });
        if (bounce.isBounce) {
          await markBouncedGmail({ cl, bounce, subject });
          bouncesFound++;
          console.log(`[ReplyTracker] ${bounce.type} bounce for lead ${cl.lead_id} in campaign ${cl.campaign_id}`);
          continue;
        }

        const verdict = classifyReply({ headers, subject, body });
        const isAuto = verdict.kind === 'auto' || verdict.kind === 'ticket';

        if (isAuto && config.autoReplyHandlingEnabled) {
          await handleAutoReply({
            cl,
            classifier: verdict,
            subject,
            body,
            snippet,
            replyMessageId: replyMsg.id ?? null,
          });
          autoRepliesFound++;
          continue;
        }

        // Either classified human, OR auto-handling is feature-flagged off.
        await markHumanReplied({ cl, snippet, body });
        repliesFound++;

        // Shadow log when feature flag is off so we can score detector
        // precision on real traffic without changing production behaviour.
        if (isAuto && !config.autoReplyHandlingEnabled) {
          try {
            await createNote(cl.lead_id, {
              type: 'auto_reply_candidate',
              content: `Reply LOOKS auto (${verdict.kind}, conf=${verdict.confidence.toFixed(2)}). Status kept as 'replied' because autoReplyHandlingEnabled=false.`,
              metadata: {
                campaign_id: cl.campaign_id,
                gmail_thread_id: cl.gmail_thread_id,
                signals: verdict.signals,
                confidence: verdict.confidence,
                snippet,
              },
            });
          } catch (e) {
            console.warn('[ReplyTracker] auto_reply_candidate note failed:', e instanceof Error ? e.message : e);
          }
        }

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

  return { repliesFound, autoRepliesFound, bouncesFound };
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function markHumanReplied(args: { cl: SentCampaignLead; snippet: string; body?: string }): Promise<void> {
  const { cl, snippet, body } = args;
  const supabase = getSupabase();

  await supabase
    .from('campaign_leads')
    .update({
      status: 'replied',
      replied_at: new Date().toISOString(),
      reply_snippet: snippet || null,
    })
    .eq('id', cl.id);

  await updateLead(cl.lead_id, { outreach_status: 'replied' });

  await createNote(cl.lead_id, {
    type: 'email_replied',
    content: `Reply received via Gmail`,
    metadata: {
      campaign_id: cl.campaign_id,
      gmail_thread_id: cl.gmail_thread_id,
      snippet,
    },
  });

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

  // Opt-out flag — a human reply asking not to be contacted. Stays 'replied'
  // (it IS a human reply); we only surface the one-click "Do Not Contact"
  // prompt in the Inbox. Suppression is operator-gated.
  const optOut = detectOptOut(body ?? snippet);
  if (optOut.isOptOut) {
    await supabase.from('campaign_leads').update({ opt_out_detected: true }).eq('id', cl.id);
    await createNote(cl.lead_id, {
      type: 'opt_out_detected',
      content: `Opt-out language in reply ("${optOut.phrase}") — review and confirm Do Not Contact`,
      metadata: { campaign_id: cl.campaign_id, phrase: optOut.phrase, gmail_thread_id: cl.gmail_thread_id },
    });
    console.log(`[ReplyTracker] opt-out detected on lead ${cl.lead_id} ("${optOut.phrase}")`);
  }
}

// Flip a matched lead to 'bounced' rather than 'replied'. Mirrors the IMAP
// bounce path: guard on status='sent' so we never downgrade a row a parallel
// poll already advanced, bump campaign total_bounced, log an activity note,
// and (hard bounces only) invalidate the dead address so it's excluded from
// future campaigns. outreach_status is left untouched — the invalid-email
// flag is what gates re-sends.
async function markBouncedGmail(args: {
  cl: SentCampaignLead;
  bounce: { type: 'hard' | 'soft'; bouncedEmail: string | null };
  subject: string;
}): Promise<void> {
  const { cl, bounce, subject } = args;
  const supabase = getSupabase();

  const { error: updateErr } = await supabase
    .from('campaign_leads')
    .update({ status: 'bounced' })
    .eq('id', cl.id)
    .eq('status', 'sent');
  if (updateErr) return;

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

  await createNote(cl.lead_id, {
    type: 'email_bounced',
    content: `Bounce detected via Gmail (${bounce.type} bounce)${bounce.bouncedEmail ? ` — ${bounce.bouncedEmail}` : ''}`,
    metadata: {
      campaign_id: cl.campaign_id,
      gmail_thread_id: cl.gmail_thread_id,
      bounce_type: bounce.type,
      bounced_email: bounce.bouncedEmail ?? cl.email_used,
      subject,
    },
  });

  if (bounce.type === 'hard') {
    await updateLead(cl.lead_id, {
      email_verified: false,
      verification_status: 'invalid',
    });
  }
}

async function handleAutoReply(args: {
  cl: SentCampaignLead;
  classifier: ReturnType<typeof classifyReply>;
  subject: string;
  body: string;
  snippet: string;
  replyMessageId: string | null;
}): Promise<void> {
  const { cl, classifier, subject, body, snippet, replyMessageId } = args;
  const supabase = getSupabase();

  // 1. Flip status — auto_replied stays out of the reply-rate aggregate.
  await supabase
    .from('campaign_leads')
    .update({
      status: 'auto_replied',
      replied_at: new Date().toISOString(),
      reply_snippet: snippet || null,
    })
    .eq('id', cl.id);

  // Lead-level outreach_status stays as 'contacted' on auto-replies — the
  // recipient hasn't engaged, an automated system answered. The Prospects
  // view picks these up via campaign_leads.status='auto_replied' instead.

  // 2. Increment campaign auto-reply counter
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('total_auto_replied')
    .eq('id', cl.campaign_id)
    .single();
  if (campaign) {
    await supabase
      .from('campaigns')
      .update({ total_auto_replied: (campaign.total_auto_replied || 0) + 1 })
      .eq('id', cl.campaign_id);
  }

  // 3. Write the audit note (always, even if extractor returns nothing)
  await createNote(cl.lead_id, {
    type: 'auto_reply_received',
    content: `Auto-reply detected (kind=${classifier.kind}, confidence=${classifier.confidence.toFixed(2)})`,
    metadata: {
      campaign_id: cl.campaign_id,
      gmail_thread_id: cl.gmail_thread_id,
      gmail_message_id: replyMessageId,
      kind: classifier.kind,
      confidence: classifier.confidence,
      signals: classifier.signals,
      subject,
      snippet,
    },
  });

  // 4. Pre-gate: extract candidates. If none, log and bail before touching
  //    discovered_contacts. This is the credit-saver — empty auto-replies
  //    (e.g. "thanks, we'll get back to you") never reach the verifier.
  const leadDomain = (cl.email_used ?? '').split('@')[1] ?? null;
  const { emails, urls } = extractContacts(body, {
    email_used: cl.email_used,
    lead_domain: leadDomain,
    // Filter out our own outreach domain — auto-replies commonly quote the
    // original message including the From: line, which would otherwise be
    // extracted as a "discovered" candidate and verify as valid.
    sender_emails: config.gmail.fromEmail ? [config.gmail.fromEmail] : [],
  });

  if (emails.length === 0 && urls.length === 0) {
    await createNote(cl.lead_id, {
      type: 'auto_reply_no_contacts',
      content: 'Auto-reply contained no extractable contact emails or partner URLs — skipping discovery pipeline.',
      metadata: {
        campaign_id: cl.campaign_id,
        gmail_thread_id: cl.gmail_thread_id,
        kind: classifier.kind,
      },
    });
    console.log(`[ReplyTracker] auto-reply on lead ${cl.lead_id} produced no candidates — pre-gated`);
    return;
  }

  // 5. Persist candidates. Each becomes a row in the review queue.
  const auditMetadata = {
    subject,
    snippet,
    kind: classifier.kind,
    confidence: classifier.confidence,
    signals: classifier.signals,
    discovered_at: new Date().toISOString(),
  };
  const messageRef = replyMessageId ?? cl.gmail_thread_id;

  for (const candidate of emails) {
    await insertDiscoveredContact({
      lead_id: cl.lead_id,
      source_campaign_lead_id: cl.id,
      kind: 'email',
      value: candidate.value,
      role: candidate.role,
      score: candidate.score,
      auto_reply_message_id: messageRef,
      auto_reply_metadata: auditMetadata,
    });
  }
  // URL candidates are gated: auto-queuing every URL mentioned in an auto-reply
  // burns Chromium time on mostly-noise (vendor signatures, company homepage we
  // already have). The user-triggered "Promote to Prospect" path in the Inbox
  // UI keeps working regardless of this flag.
  let queuedUrls = 0;
  if (config.autoQueueUrlsFromReplies) {
    for (const candidate of urls) {
      await insertDiscoveredContact({
        lead_id: cl.lead_id,
        source_campaign_lead_id: cl.id,
        kind: 'url',
        value: candidate.value,
        role: candidate.signal,
        score: candidate.score,
        auto_reply_message_id: messageRef,
        auto_reply_metadata: auditMetadata,
      });
    }
    queuedUrls = urls.length;
  }

  console.log(
    `[ReplyTracker] auto-reply on lead ${cl.lead_id}: ${emails.length} email + ${queuedUrls}/${urls.length} URL candidate(s) queued${config.autoQueueUrlsFromReplies ? '' : ' (URLs skipped — auto-queue disabled)'}`,
  );
}

function headersToMap(headers: GmailHeader[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (!h.name) continue;
    // Last value wins; Gmail rarely has duplicates on the headers we read.
    out[h.name.toLowerCase()] = h.value ?? '';
  }
  return out;
}

function pickHeader(headers: Record<string, string>, name: string): string {
  return headers[name.toLowerCase()] ?? '';
}

/** Walk the MIME tree and return the best body text for scanning. Prefers
 *  text/plain; falls back to text/html with tags stripped. */
function extractBodyText(part: GmailPart | null): string {
  if (!part) return '';
  const plain = walkForMime(part, 'text/plain');
  if (plain) return plain;
  const html = walkForMime(part, 'text/html');
  return html;
}

function walkForMime(part: GmailPart, mime: string): string {
  if ((part.mimeType ?? '').toLowerCase() === mime && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const sub of part.parts ?? []) {
    const found = walkForMime(sub, mime);
    if (found) return found;
  }
  return '';
}

function decodeBase64Url(data: string): string {
  // Gmail's body.data is base64url; convert to standard base64 and decode.
  const std = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(std, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

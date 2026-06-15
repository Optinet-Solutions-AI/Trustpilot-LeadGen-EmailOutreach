/**
 * Auto-reply detector — classifies an inbound message as human vs. automated.
 *
 * Used by both reply-tracker.ts (Gmail) and reply-tracker.imap.ts (SMTP) to
 * decide whether a reply should mark campaign_leads.status='replied' (real
 * engagement, counted toward reply rate) or 'auto_replied' (auto-routed
 * contact info; surfaces a discovery candidate but is not a buy-signal).
 *
 * The classifier layers three signal sources and produces a confidence score:
 *   1. RFC headers (Auto-Submitted, X-Autoreply, Precedence: bulk, ...)
 *      — near-deterministic when present.
 *   2. Subject regex ("out of office", "[ticket #...", "automatic reply")
 *      — strong but not deterministic.
 *   3. Body phrases ("this inbox is unmonitored", "do not reply", ...)
 *      — weakest, falsifiable, used as a tiebreaker.
 *
 * Helpdesk patterns (Zendesk, Freshdesk, Helpscout, Intercom, ticket numbers)
 * branch to kind='ticket' so downstream code can apply ticket-specific
 * extraction rules — these are the highest-yield discoveries because they
 * routinely embed the human-routing email in the auto-acknowledgement body.
 */

export type ReplyKind = 'human' | 'auto' | 'ticket';

export interface ClassifyInput {
  /** Header map. Keys can be any case; lookups are case-insensitive. */
  headers: Record<string, string | string[] | undefined>;
  subject: string;
  body: string;
}

export interface ClassifyResult {
  kind: ReplyKind;
  confidence: number;     // 0–1; higher = more confident this is auto/ticket
  signals: string[];      // human-readable list for audit logs
}

/** Threshold below which we treat the reply as a real human reply. */
const HUMAN_THRESHOLD = 0.4;

const HEADER_AUTO_SIGNALS: Array<{ name: string; pattern: RegExp; weight: number; label: string }> = [
  // RFC 3834 — the standards-compliant marker for auto-responses
  { name: 'auto-submitted', pattern: /\bauto-(replied|generated|notified)\b/i, weight: 0.7, label: 'header:auto-submitted' },
  // Microsoft Exchange / Outlook OOO marker
  { name: 'x-autoreply',   pattern: /./,                                       weight: 0.7, label: 'header:x-autoreply' },
  { name: 'x-autorespond', pattern: /./,                                       weight: 0.7, label: 'header:x-autorespond' },
  // Some servers use this to suppress auto-responses to other autos
  { name: 'x-auto-response-suppress', pattern: /./,                            weight: 0.4, label: 'header:x-auto-response-suppress' },
  // Precedence: bulk/junk/auto_reply/list — bulk-mail markers
  { name: 'precedence',    pattern: /\b(bulk|junk|auto[_-]?reply|list)\b/i,     weight: 0.5, label: 'header:precedence' },
];

const HEADER_TICKET_SIGNALS: Array<{ name: string; pattern: RegExp; label: string }> = [
  { name: 'x-zendesk-ticket', pattern: /./, label: 'header:zendesk' },
  { name: 'x-zd-account',     pattern: /./, label: 'header:zendesk' },
  { name: 'x-freshdesk-id',   pattern: /./, label: 'header:freshdesk' },
  { name: 'x-fd-account',     pattern: /./, label: 'header:freshdesk' },
  { name: 'x-helpscout-id',   pattern: /./, label: 'header:helpscout' },
  { name: 'x-intercom-id',    pattern: /./, label: 'header:intercom' },
  // Some helpdesks tag List-Id; less specific but still strong
  { name: 'list-id',          pattern: /(zendesk|freshdesk|helpscout|intercom|kayako)/i, label: 'header:list-id-helpdesk' },
];

const SUBJECT_AUTO_SIGNALS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  // "Auto: ", "Automatic Reply", "Automatic response"
  { pattern: /^\s*(auto(matic)?[\s:.-]|automatic\s+(reply|response))/i, weight: 0.4, label: 'subject:auto-prefix' },
  // Out of office variants (English + a few common European languages OptiRate
  // sees in DACH/NL/FR scrapes)
  { pattern: /\b(out\s+of\s+office|on\s+vacation|currently\s+(away|out)|on\s+holiday)\b/i, weight: 0.4, label: 'subject:ooo' },
  { pattern: /\b(abwesenheit|automatische\s+antwort|absence|ferienmitteilung|nicht\s+im\s+b[üu]ro)\b/i, weight: 0.4, label: 'subject:ooo-de' },
  { pattern: /\b(absence|absent|hors\s+du\s+bureau|vacances|cong[ée]s?)\b/i, weight: 0.3, label: 'subject:ooo-fr' },
  { pattern: /\b(afwezig|vakantie|niet\s+aanwezig)\b/i, weight: 0.3, label: 'subject:ooo-nl' },
  // Auto-acknowledgement subjects — confirmation openers a cold prospect
  // effectively never sends (we contacted them, not the reverse). Kept at a
  // sub-threshold weight so one alone can't flip a real reply, but they stack
  // with body signals on a typical "we got your message" autoresponder.
  { pattern: /\bthank(s| you)\s+for\s+(contacting|reaching\s+out|getting\s+in\s+touch|your\s+(e?mail|message|inquiry|enquiry|request))/i, weight: 0.3, label: 'subject:thank-you-ack' },
  { pattern: /\b(we('ve| have)\s+)?received\s+your\s+(e?mail|message|inquiry|enquiry|request)\b/i, weight: 0.4, label: 'subject:received-ack' },
];

const SUBJECT_TICKET_SIGNALS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\[\s*(ticket|case|request)\s*#?\s*\d+/i, label: 'subject:ticket-number' },
  { pattern: /\[\s*#\s*\d+\s*\]/, label: 'subject:hash-number' },
  { pattern: /\bticket\s+(id|number)[:#\s]/i, label: 'subject:ticket-id' },
  { pattern: /^\s*re:\s*\[\s*#\d+/i, label: 'subject:re-ticket' },
  // "Ticket #27865" without surrounding brackets (Kickr-style helpdesk)
  { pattern: /\bticket\s*#\s*\d+\b/i, label: 'subject:ticket-hash' },
  // "Customer Support - Ticket", "Support Ticket"
  { pattern: /\b(customer\s+support|support\s+team|helpdesk)\s*[-:]?\s*ticket\b/i, label: 'subject:support-ticket' },
  // "[Request received]" / "[Case received]" / "[Ticket received]" without a number
  { pattern: /^\s*\[\s*(request|case|ticket|inquiry)(\s+(received|created|opened|registered|submitted))?\s*\]/i, label: 'subject:bracket-request-received' },
  // "[BrandName] Re: ..." — branded helpdesk prefix at start of subject.
  // Excludes the warmup-pool tag "[ref:xxxx]" which appears at the END of the
  // subject (these arrive at the START), so it can't false-positive on warmup.
  { pattern: /^\s*\[\s*(?!ref:)[a-z][\w\s.\-]{0,40}\]\s*re:\s/i, label: 'subject:bracket-brand-re' },
  // Bare helpdesk subjects without bracketed numbers — "Support request",
  // "Case number ...", "Your reference: AB12CD".
  { pattern: /\b(support|service|help)\s+request\b/i, label: 'subject:support-request' },
  { pattern: /\bcase\s*(number|no\.?|id|#)\b/i, label: 'subject:case-number' },
  { pattern: /\b(your\s+)?(reference|ref)\s*[:#]\s*[a-z0-9][a-z0-9\-]{2,}/i, label: 'subject:reference-code' },
];

const BODY_AUTO_SIGNALS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /this\s+(inbox|mailbox|address|email)\s+is\s+(not\s+)?(monitored|unmonitored|unattended|read|checked)/i, weight: 0.5, label: 'body:unmonitored' },
  { pattern: /(do\s+not|please\s+do\s+not|don't)\s+(reply|respond)\s+to\s+this/i, weight: 0.4, label: 'body:do-not-reply' },
  { pattern: /this\s+is\s+an?\s+(automated|automatic)\s+(reply|response|message|notification)/i, weight: 0.6, label: 'body:automated-message' },
  { pattern: /(out\s+of|away\s+from)\s+(the\s+)?office\s+(until|from|between)/i, weight: 0.5, label: 'body:ooo' },
  { pattern: /i\s+(am|will\s+be)\s+(out\s+of|away\s+from|on)\s+(the\s+)?(office|vacation|holiday|leave)/i, weight: 0.4, label: 'body:i-am-out' },
  // Helpdesk auto-acknowledgements
  { pattern: /(your|the)\s+(ticket|request|case)\s+(has\s+been|was|is)\s+(received|created|opened)/i, weight: 0.5, label: 'body:ticket-received' },
  { pattern: /we('ve|\s+have)\s+received\s+your\s+(message|email|request|inquiry)/i, weight: 0.4, label: 'body:received-confirmation' },
  // Routing instructions that almost always mean "this is an auto-router"
  { pattern: /for\s+(affiliate|partnership|partner|press|media|business|sales|marketing)\s+(inquiries|inquiries?|requests?|matters?|please)/i, weight: 0.5, label: 'body:routing-instructions' },
  { pattern: /please\s+(contact|email|reach\s+out\s+to|write\s+to)\s+[\w.+-]+@[\w.-]+/i, weight: 0.4, label: 'body:please-contact' },
  // Auto-acknowledgement bodies — the canonical "we got your message, a human
  // will reply later" autoresponder that ticket systems and shared inboxes
  // emit. Individually modest, but they stack into a clear auto verdict.
  { pattern: /thank(?:s| you)\s+for\s+(contacting|reaching\s+out|getting\s+in\s+touch|your\s+(e?mail|message|inquiry|enquiry|interest|request|query|patience))/i, weight: 0.3, label: 'body:thank-you-ack' },
  { pattern: /(our\s+team|a\s+member\s+of\s+(our|the)\s+team|someone\s+(from|on)\s+(our|the)\s+team)\s+(will|'ll)\s+(get\s+back|be\s+in\s+touch|respond|reply|review)/i, weight: 0.5, label: 'body:team-will-respond' },
  // "respond to your query as soon as possible", "we aim to respond within 48
  // hours" — the verb and the time-promise can be separated by an object, so
  // allow a short gap. Restricted to strong time phrases ("as soon as
  // possible" / "within N hours/days") to avoid catching a human "I'll reply
  // shortly".
  { pattern: /\b(respond|reply|get\s+back\s+to\s+you|aim\s+to\s+respond)\b[^.\n]{0,40}?\b(as\s+soon\s+as\s+possible|within\s+\d+\s*(?:business\s+)?(?:hour|day))/i, weight: 0.4, label: 'body:respond-soon' },
  { pattern: /\bwithin\s+\d+\s*(business\s+)?(hour|day)s?\b/i, weight: 0.3, label: 'body:within-timeframe' },
  { pattern: /\byour\s+(message|request|e?mail|inquiry|enquiry|ticket|case)\s+(has\s+been|was|is)\s+(logged|registered|queued|assigned)/i, weight: 0.5, label: 'body:message-logged' },
  // Shared "contact us" inbox autoresponder hallmarks: stating opening hours,
  // and deflecting to a self-service help centre / FAQ. A real prospect
  // replying to cold outreach doesn't volunteer their opening hours or link
  // their own help desk — staffed shared inboxes auto-reply with exactly this.
  { pattern: /\b(opening|office|business)\s+hours\s+(are|of\s+operation)\b/i, weight: 0.4, label: 'body:business-hours' },
  { pattern: /\b(help\s+(centre|center)|knowledge\s+base|support\s+(portal|centre|center))\b/i, weight: 0.3, label: 'body:self-service' },
];

const BODY_TICKET_SIGNALS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(zendesk|freshdesk|helpscout|intercom|kayako|gorgias|frontapp)/i, label: 'body:helpdesk-product' },
  { pattern: /ticket\s+(id|number|#)\s*[:=#]?\s*\d/i, label: 'body:ticket-id-line' },
  // Alphanumeric reference/case codes ("Reference number: AB-12345",
  // "Your case ID is 88421") — strong ticket-issuance markers.
  { pattern: /\b(reference|case|ticket)\s*(number|no\.?|id|#)\s*[:=#]?\s*[a-z0-9][a-z0-9\-]{2,}/i, label: 'body:reference-code' },
  { pattern: /\byour\s+(reference|case|ticket)\s+(is|number|id|#)/i, label: 'body:your-reference' },
];

function pickHeader(headers: ClassifyInput['headers'], name: string): string {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      if (Array.isArray(value)) return value.join(', ');
      return String(value ?? '');
    }
  }
  return '';
}

/**
 * Classify an inbound message. Pure function — no IO, deterministic for a
 * given input. Safe to call from both Gmail and IMAP code paths.
 */
export function classifyReply(input: ClassifyInput): ClassifyResult {
  const signals: string[] = [];
  let autoConfidence = 0;
  let isTicket = false;

  // ── Header signals ─────────────────────────────────────────────
  for (const sig of HEADER_AUTO_SIGNALS) {
    const value = pickHeader(input.headers, sig.name);
    if (value && sig.pattern.test(value)) {
      autoConfidence += sig.weight;
      signals.push(sig.label);
    }
  }
  for (const sig of HEADER_TICKET_SIGNALS) {
    const value = pickHeader(input.headers, sig.name);
    if (value && sig.pattern.test(value)) {
      isTicket = true;
      autoConfidence += 0.5;       // ticket headers are also auto signals
      signals.push(sig.label);
    }
  }

  // ── Subject signals ───────────────────────────────────────────
  const subject = input.subject || '';
  for (const sig of SUBJECT_AUTO_SIGNALS) {
    if (sig.pattern.test(subject)) {
      autoConfidence += sig.weight;
      signals.push(sig.label);
    }
  }
  for (const sig of SUBJECT_TICKET_SIGNALS) {
    if (sig.pattern.test(subject)) {
      isTicket = true;
      autoConfidence += 0.4;
      signals.push(sig.label);
    }
  }

  // ── Body signals ──────────────────────────────────────────────
  // Strip HTML to plain-ish text so the body regexes don't match in <style>
  // or attribute values; mailparser already gives us text in the IMAP path
  // and Gmail's snippet+full-body access gives us text via mime walks.
  const body = stripHtmlForScan(input.body || '');
  for (const sig of BODY_AUTO_SIGNALS) {
    if (sig.pattern.test(body)) {
      autoConfidence += sig.weight;
      signals.push(sig.label);
    }
  }
  for (const sig of BODY_TICKET_SIGNALS) {
    if (sig.pattern.test(body)) {
      isTicket = true;
      autoConfidence += 0.3;
      signals.push(sig.label);
    }
  }

  // Cap confidence at 1.0 to keep the score interpretable
  if (autoConfidence > 1) autoConfidence = 1;

  let kind: ReplyKind;
  if (isTicket) {
    kind = 'ticket';
  } else if (autoConfidence >= HUMAN_THRESHOLD) {
    kind = 'auto';
  } else {
    kind = 'human';
  }

  return { kind, confidence: autoConfidence, signals };
}

/** Cheap HTML→text for scan purposes only. Not for display. */
function stripHtmlForScan(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

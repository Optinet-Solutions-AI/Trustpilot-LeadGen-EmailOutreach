/**
 * Auto-reply contact extractor.
 *
 * Given the body of an auto-reply that the detector classified as kind='auto'
 * or kind='ticket', pull out:
 *   1. Email addresses that look like real corporate routing contacts
 *      (affiliates@, partnerships@, marketing@, ceo@, ...). Filters out the
 *      original recipient, freemail providers, helpdesk routing addresses
 *      that show up in helpdesk auto-acks but don't help us.
 *   2. URLs to potential partner/affiliate brand sites. Filters out social
 *      media, image/asset URLs, the lead's own domain, and tracker domains.
 *
 * Both lists are ranked by a role-score so the highest-value contact (e.g.
 * "for affiliates contact partners@brand.com") surfaces at the top of the
 * Prospects review queue.
 */

export interface ExtractContext {
  /** The address we originally emailed — echoes are noise, not discoveries. */
  email_used?: string | null;
  /** The lead's brand domain (e.g. "brandcasino.com") if known — used so
   *  same-domain partner URLs aren't filtered out as "the lead's own site". */
  lead_domain?: string | null;
  /** Our outreach sender addresses (e.g. james@optiratesolutions.net,
   *  jordi@optiratesolutions.com). Auto-replies routinely quote the original
   *  message including its From: header, so without this filter our own
   *  email gets extracted as a "discovered" candidate, verified as valid
   *  (because it really is a valid mailbox — ours), and surfaces in the
   *  Prospects view as a contact to email — clearly wrong. Filtering both
   *  the exact sender addresses AND any same-domain address protects against
   *  multi-mailbox setups (jordi@, sarah@, etc on the same outreach domain). */
  sender_emails?: string[];
}

export interface RankedEmail {
  value: string;
  role: string | null;     // 'affiliate' | 'partnerships' | etc, or null
  score: number;
}

export interface RankedUrl {
  value: string;
  score: number;
  signal: string | null;   // why we picked it: 'affiliate', 'partner', etc.
}

export interface ExtractResult {
  emails: RankedEmail[];
  urls: RankedUrl[];
}

// Free-mailbox providers — auto-replies that disclose a gmail.com address
// are almost always personal/spam and not the corporate routing contact we
// want. Drops false positives without losing meaningful leads.
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.fr', 'yahoo.de', 'yahoo.it', 'yahoo.es',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'gmx.net', 'gmx.us',
  'web.de', 't-online.de',
  'yandex.com', 'yandex.ru',
  'aol.com', 'aol.co.uk',
  'mail.com', 'mail.ru',
  'zoho.com', 'fastmail.com',
]);

// Truly never-useful domains. Pure asset CDNs, tracking pixels, error-
// reporting backends — anywhere that even a 302 redirect would land on
// content not relevant to a partner brand contact page. Anything appearing
// here gets dropped from both the email and URL candidate lists.
//
// What's deliberately NOT filtered: ESP click-tracker domains like
// `intercom-mail.*`, `*.list-manage.com`, `mandrillapp.com`,
// `sendgrid.net`, `mailtrack.io`. These ARE 302 redirects, but the
// destination is the URL the operator put in their auto-reply — which is
// exactly what we want the scraper to land on. Letting the URL reach the
// scraper is strictly better than dropping it; if the redirect target has
// no email, the candidate sits with an empty scrape_result and the user
// dismisses. False negatives (missed real partner sites) cost the user
// more than false positives (a wasted scrape on a 1×1 pixel).
const TRACKING_DOMAIN_RX = /(?:^|\.)(googleusercontent\.com|gstatic\.com|google-analytics\.com|doubleclick\.net|fbcdn\.net|twimg\.com|cloudfront\.net|sentry\.io|herokuapp\.com|intercomcdn\.com|amazonses\.com|s3\.amazonaws\.com|emltrk\.com)$/i;

const NOREPLY_LOCAL_RX = /^(noreply|no-reply|donotreply|do-not-reply|notifications?|notify|mailer-daemon|postmaster|bounce|bounces|automated|autoresponder)$/i;

const IMAGE_ASSET_RX = /\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|eot|pdf|zip|map)(\?|$)/i;

const SOCIAL_DOMAIN_RX = /(?:^|\.)(twitter\.com|x\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|tiktok\.com|pinterest\.com|reddit\.com|t\.me|telegram\.me)$/i;

// Role-score table — captures the rough business value of each role. Tuned
// against OptiRate's pitch (reputation-management for low-rated brands), so
// affiliate/partnership routing tops the list because that's the team most
// likely to engage on a "your Trustpilot rating is hurting conversions" pitch.
const ROLE_SCORES: Array<{ rx: RegExp; role: string; score: number }> = [
  { rx: /^affiliates?$/i,                role: 'affiliate',    score: 10 },
  { rx: /^partnerships?$/i,              role: 'partnerships', score: 10 },
  { rx: /^partners?$/i,                  role: 'partners',     score: 10 },
  { rx: /^(ceo|founder|owner|president)$/i, role: 'executive', score: 9 },
  { rx: /^(press|pr|media|comms)$/i,     role: 'press',        score: 8 },
  { rx: /^(business|bd|biz|bizdev)$/i,   role: 'business',     score: 8 },
  { rx: /^(marketing|growth|brand)$/i,   role: 'marketing',    score: 7 },
  { rx: /^(sales|crm)$/i,                role: 'sales',        score: 6 },
  { rx: /^(finance|accounts?|billing)$/i, role: 'finance',     score: 4 },
  { rx: /^(contact|hello|hi|enquiries|enquiry)$/i, role: 'contact', score: 3 },
];

const URL_SIGNALS: Array<{ rx: RegExp; signal: string; score: number }> = [
  { rx: /\b(affiliate|partners?)\b/i, signal: 'affiliate', score: 10 },
  { rx: /\b(programme|program)\b/i,   signal: 'program',   score: 6 },
  { rx: /\b(business|enterprise)\b/i, signal: 'business',  score: 5 },
  { rx: /\b(press|media)\b/i,         signal: 'press',     score: 5 },
];

const EMAIL_RX = /[\w.+\-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_RX   = /https?:\/\/[\w\-.]+(?:\/[^\s<>"'`)\]]*)?/gi;
// Bare-domain match — only applied when the URL match yielded nothing for a
// given line. Anchored by space or start-of-string + a TLD-like ending.
const BARE_DOMAIN_RX = /(?:^|[\s>])((?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+[a-z]{2,})\b/gi;

function localPartOf(email: string): string {
  return email.split('@')[0] ?? '';
}

function domainOf(emailOrUrl: string): string {
  if (emailOrUrl.includes('@')) {
    return (emailOrUrl.split('@')[1] ?? '').toLowerCase();
  }
  // URL: strip protocol + path
  const m = emailOrUrl.match(/^(?:https?:\/\/)?([^\/\s?#]+)/i);
  return (m?.[1] ?? '').toLowerCase();
}

function scoreEmailRole(email: string, leadDomain: string | null): { role: string | null; score: number } {
  const local = localPartOf(email).toLowerCase();
  const domain = domainOf(email);

  for (const { rx, role, score } of ROLE_SCORES) {
    if (rx.test(local)) {
      // Same-domain bonus: routing addresses on the lead's own brand domain
      // are far more useful than the same role-name on a third party.
      const sameDomainBonus = leadDomain && domain.endsWith(leadDomain) ? 1 : 0;
      return { role, score: score + sameDomainBonus };
    }
  }
  // No role match → low default score; same-domain bonus still applies so a
  // generic alias on the lead's own domain ranks above a random third-party.
  const sameDomainBonus = leadDomain && domain.endsWith(leadDomain) ? 1 : 0;
  return { role: null, score: 1 + sameDomainBonus };
}

function isFreemail(email: string): boolean {
  return FREEMAIL_DOMAINS.has(domainOf(email));
}

function isTrackingDomain(domain: string): boolean {
  return TRACKING_DOMAIN_RX.test(domain);
}

function isSocialDomain(domain: string): boolean {
  return SOCIAL_DOMAIN_RX.test(domain);
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.,;:)\]]+$/, '');
}

function normalizeUrl(raw: string): string {
  // Strip trailing punctuation that often glues onto a regex match
  return raw.trim().replace(/[.,;:)\]'"]+$/, '');
}

function ensureProtocol(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Extract email + URL contacts from an auto-reply body.
 *
 * @param body The plain-text or HTML body of the auto-reply.
 * @param ctx  Context (original recipient, lead domain) used to filter noise.
 */
export function extractContacts(body: string, ctx: ExtractContext): ExtractResult {
  const text = body || '';
  const echoedEmail = normalizeEmail(ctx.email_used ?? '');
  const echoedDomain = echoedEmail ? domainOf(echoedEmail) : '';
  const leadDomain = (ctx.lead_domain ?? '').toLowerCase().replace(/^www\./, '');
  // Build the sender-side denylist once. Both exact emails and domains so a
  // multi-mailbox outreach setup (sarah@, jordi@, james@ on the same domain)
  // is fully covered when only one of the addresses appears in the context.
  const senderEmailSet = new Set<string>();
  const senderDomainSet = new Set<string>();
  for (const raw of ctx.sender_emails ?? []) {
    const norm = normalizeEmail(raw);
    if (!norm) continue;
    senderEmailSet.add(norm);
    const dom = domainOf(norm);
    if (dom) senderDomainSet.add(dom);
  }

  // ── Emails ───────────────────────────────────────────────────
  const seen = new Set<string>();
  const emailCandidates: RankedEmail[] = [];

  for (const match of text.match(EMAIL_RX) ?? []) {
    const norm = normalizeEmail(match);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);

    const domain = domainOf(norm);
    const local  = localPartOf(norm).toLowerCase();

    // 1. Skip the original recipient — echoed back means nothing.
    if (echoedEmail && norm === echoedEmail) continue;

    // 1b. Skip our own outreach sender addresses (and anything on the same
    //     domain). Auto-replies frequently quote the original message back,
    //     including its From: header, which would otherwise yield "discover
    //     yourself" candidates that verify as valid and surface as fake
    //     prospects.
    if (senderEmailSet.has(norm)) continue;
    const candidateDomain = domainOf(norm);
    if (candidateDomain && senderDomainSet.has(candidateDomain)) continue;

    // 2. Skip no-reply / postmaster / mailer-daemon — never the human contact.
    if (NOREPLY_LOCAL_RX.test(local)) continue;

    // 3. Skip helpdesk/tracking domains.
    if (isTrackingDomain(domain)) continue;

    // 4. Skip free-mailbox providers (gmail/yahoo/outlook/...).
    //    Auto-replies disclosing a personal-email contact are extremely rare
    //    and the false-positive rate is high. We accept losing these so the
    //    review queue stays signal-dense.
    if (isFreemail(norm)) continue;

    // 5. Skip same-role echoes on the lead's domain — if we already emailed
    //    support@brand.com, getting back another support@brand.com (e.g.
    //    forwarded copy) is just noise, not a discovery.
    if (echoedEmail && local === localPartOf(echoedEmail).toLowerCase() && domain === echoedDomain) continue;

    const { role, score } = scoreEmailRole(norm, leadDomain || null);
    emailCandidates.push({ value: norm, role, score });
  }

  emailCandidates.sort((a, b) => b.score - a.score);
  const emails = emailCandidates.slice(0, 3);

  // ── URLs ─────────────────────────────────────────────────────
  const urlSeen = new Set<string>();
  const urlCandidates: RankedUrl[] = [];

  // Pass 1 — explicit http(s) URLs
  for (const rawMatch of text.match(URL_RX) ?? []) {
    const url = normalizeUrl(rawMatch);
    if (!url) continue;
    const lower = url.toLowerCase();
    if (urlSeen.has(lower)) continue;
    urlSeen.add(lower);

    if (IMAGE_ASSET_RX.test(url)) continue;

    const domain = domainOf(url).replace(/^www\./, '');
    if (!domain) continue;
    if (isTrackingDomain(domain)) continue;
    if (isSocialDomain(domain)) continue;

    // Skip if this URL is just a redirect back to the lead's own primary
    // domain WITHOUT any partner/affiliate signal. We don't want to "discover"
    // the marketing site we already scraped. But /affiliates on the same
    // domain IS interesting — that's exactly the partner page.
    let signal: string | null = null;
    let baseScore = 2;
    for (const sig of URL_SIGNALS) {
      if (sig.rx.test(url)) {
        signal = sig.signal;
        baseScore = sig.score;
        break;
      }
    }
    if (leadDomain && domain.endsWith(leadDomain) && signal === null) continue;

    urlCandidates.push({ value: url, score: baseScore, signal });
  }

  // Pass 2 — bare-domain mentions (only used if pass 1 yielded nothing,
  // since bare-domain regex has a higher false-positive rate)
  if (urlCandidates.length === 0) {
    for (const m of text.matchAll(BARE_DOMAIN_RX)) {
      const raw = m[1];
      if (!raw) continue;
      const lower = raw.toLowerCase().replace(/^www\./, '');
      if (urlSeen.has(lower)) continue;
      urlSeen.add(lower);

      // Reject things that look like email-domain fragments or sentence
      // punctuation. Need at least one letter in TLD.
      if (!/\.[a-z]{2,}$/i.test(lower)) continue;
      if (lower.endsWith('.com.') || lower.endsWith('.net.')) continue;
      if (isTrackingDomain(lower)) continue;
      if (isSocialDomain(lower)) continue;
      if (echoedDomain && lower === echoedDomain) continue;
      if (leadDomain && lower === leadDomain) continue;

      // Score based on signal words elsewhere in the line — we don't have
      // line context here, so default score is low and only includes if the
      // domain itself contains a signal.
      let signal: string | null = null;
      let score = 2;
      for (const sig of URL_SIGNALS) {
        if (sig.rx.test(lower)) {
          signal = sig.signal;
          score = sig.score;
          break;
        }
      }
      urlCandidates.push({ value: ensureProtocol(lower), score, signal });
    }
  }

  urlCandidates.sort((a, b) => b.score - a.score);
  const urls = urlCandidates.slice(0, 2);

  return { emails, urls };
}

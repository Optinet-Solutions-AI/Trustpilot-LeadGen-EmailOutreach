/**
 * Website email enricher — TypeScript port with tier escalation.
 *
 * Flow per lead:
 *   1. Try tier 2 (stealth) — sufficient for ~80% of sites
 *   2. On bot-detection failure, escalate to tier 3 (datacenter proxy) if configured
 *   3. Still blocked → tier 4 (residential proxy) if configured
 *   4. Final fallback — MX-validated guess (info@/contact@/support@ @ domain)
 *
 * Extraction strategies (in order per page):
 *   A. mailto: links + data-email attributes
 *   B. JSON-LD structured data (Schema.org Organization.contactPoint.email)
 *   C. Inline <script> block scanning (window configs, split strings)
 *   D. Body innerText + raw HTML regex
 *   E. Obfuscated patterns: user [at] domain [dot] com
 *
 * URL discovery strategies:
 *   1. Guessed contact paths (expanded list)
 *   2. Sitemap.xml crawl → find real contact/about page URLs
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import { launchBrowser, TIER_CONFIGS, humanDelay, type Tier } from './browser-launcher.js';
import { dismissPopups, handleCloudflareChallenge, detectBlock } from './popup-handler.js';
import { tier1_5TlsFetch } from './tier1_5_tls.js';
import { fetchViaScrapingbee, scrapingbeeEnabled } from './tier5-scrapingbee.js';
import { fetchViaScrapfly, scrapflyEnabled } from './tier5b-scrapfly.js';
import { tier6WhoisLookup } from './tier6-whois.js';
import { tier7WaybackLookup } from './tier7-wayback.js';
import { tier8CrtshLookup } from './tier8-crtsh.js';
import { tier9HunterLookup, hunterEnabled } from './tier9-hunter.js';

// Use explicit DNS servers. System DNS on Cloud Run can be flaky and may refuse
// MX queries when the instance is cold. Google + Cloudflare are always reachable.
const _resolver = new Resolver();
_resolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

// ─── Email classification ────────────────────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Obfuscated pattern — REQUIRES brackets or parens around "at"/"dot" so we don't
// match natural English ("changed at anytime to…"). Only catches deliberate
// obfuscation like: user [at] domain [dot] com / user(at)domain(dot)com
const OBFUSCATED_RE = /([a-zA-Z0-9._%+\-]+)\s*[[(]\s*(?:at|AT)\s*[\])]\s*([a-zA-Z0-9\-]+)\s*[[(]\s*(?:dot|DOT)\s*[\])]\s*([a-zA-Z]{2,})/g;

const UNDELIVERABLE_PREFIXES = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
  'postmaster', 'mailer-daemon', 'bounce', 'bounces', 'abuse',
  'spam', 'unsubscribe', 'webmaster',
]);

const TOP_PREFIXES = new Set([
  'contact', 'hello', 'hi', 'sales', 'partnerships', 'partner',
  'business', 'marketing', 'outreach', 'pr', 'media',
]);

const ACCEPTABLE_PREFIXES = new Set([
  'info', 'enquiries', 'enquiry', 'inquiries', 'inquiry',
  'office', 'team', 'mail', 'email', 'general', 'admin',
  'reception', 'help', 'support',
]);

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'aol.com', 'mail.com', 'protonmail.com', 'yandex.com',
  'gmx.com', 'gmx.de', 'web.de', 'zoho.com',
  'zendesk.com', 'freshdesk.com', 'helpscout.com', 'intercom.io',
  'salesforce.com', 'hubspot.com', 'mailchimp.com', 'sendgrid.net',
]);

// TLDs that look like email TLDs but are actually file extensions or code.
// Minified JS/CSS often contains identifier@file.js patterns that match the email regex.
const INVALID_TLDS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'css', 'scss', 'sass', 'less',
  'html', 'htm', 'php', 'asp', 'aspx',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico',
  'json', 'xml', 'yaml', 'yml', 'toml',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'mp3', 'wav',
  'map', 'lock', 'log',
]);

// ─── Contact sub-paths to probe when homepage yields nothing ────────────────

const CONTACT_PATHS = [
  // English
  '/contact', '/contact-us', '/contact_us', '/contacts',
  '/about', '/about-us', '/about_us',
  '/support', '/help', '/help-center',
  '/team', '/our-team', '/meet-the-team',
  '/legal', '/privacy', '/privacy-policy',
  // German
  '/impressum', '/kontakt', '/datenschutz', '/ueber-uns',
  // Spanish / French / Italian
  '/contacto', '/contactez-nous', '/contatti', '/contato',
  // Other common patterns
  '/reach-us', '/get-in-touch', '/write-to-us',
  '/company', '/company/contact', '/company/about',
  '/en/contact', '/en/contact-us', '/en/about',
  '/de/kontakt', '/de/impressum',
];

// Keywords that identify a sitemap URL as a contact/about page worth visiting
const SITEMAP_CONTACT_KEYWORDS = [
  'contact', 'kontakt', 'contacto', 'about', 'ueber', 'impressum',
  'legal', 'support', 'help', 'team', 'privacy', 'datenschutz',
  'reach', 'touch', 'company', 'write', 'contatti', 'contato',
];

// Lateral-prospecting keywords. When the main domain has no public email,
// many casino/affiliate-driven brands route business contact through a
// separate affiliate landing (e.g. spinjo.com → roosterpartners.com). We
// scan the homepage's <a> tags for these keywords in href OR text and
// follow the first few unique URLs.
const AFFILIATE_KEYWORDS = ['affiliate', 'affiliates', 'partner', 'partners'];
const MAX_AFFILIATE_PROBES = 3;

// ────────────────────────────────────────────────────────────────────────────

/**
 * Map the lead's free-text country column ("Norway", "United Kingdom") to a
 * 2-letter ISO code that ScrapingBee / ScrapFly accept for proxy geo-targeting.
 * Country names come from the Trustpilot scrape so the spelling is consistent.
 * Unknown values return null — callers fall back to the provider's default pool.
 */
const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  'norway': 'no', 'sweden': 'se', 'denmark': 'dk', 'finland': 'fi', 'iceland': 'is',
  'germany': 'de', 'austria': 'at', 'switzerland': 'ch',
  'united kingdom': 'gb', 'uk': 'gb', 'great britain': 'gb', 'england': 'gb',
  'ireland': 'ie',
  'united states': 'us', 'usa': 'us', 'us': 'us',
  'canada': 'ca', 'australia': 'au', 'new zealand': 'nz',
  'france': 'fr', 'spain': 'es', 'italy': 'it', 'portugal': 'pt',
  'netherlands': 'nl', 'belgium': 'be', 'luxembourg': 'lu',
  'poland': 'pl', 'czech republic': 'cz', 'czechia': 'cz', 'slovakia': 'sk',
  'hungary': 'hu', 'romania': 'ro', 'bulgaria': 'bg', 'greece': 'gr',
  'estonia': 'ee', 'latvia': 'lv', 'lithuania': 'lt',
  'croatia': 'hr', 'slovenia': 'si', 'serbia': 'rs',
  'turkey': 'tr', 'cyprus': 'cy', 'malta': 'mt',
  'japan': 'jp', 'south korea': 'kr', 'singapore': 'sg', 'india': 'in',
  'brazil': 'br', 'mexico': 'mx', 'argentina': 'ar', 'chile': 'cl',
  'south africa': 'za', 'united arab emirates': 'ae', 'uae': 'ae',
};

export function countryNameToIso2(country: string | null | undefined): string | undefined {
  if (!country) return undefined;
  const key = country.trim().toLowerCase();
  // The leads.country column historically held full names ("Norway"), but the
  // newer scraper writes ISO2 codes ("NO"). Accept either form: pass through
  // anything that already looks like a 2-letter code, look up everything else.
  if (/^[a-z]{2}$/.test(key)) return key;
  return COUNTRY_NAME_TO_ISO2[key];
}

function isUndeliverable(email: string): boolean {
  return UNDELIVERABLE_PREFIXES.has(email.split('@')[0].toLowerCase());
}

function isFreeProvider(email: string): boolean {
  const parts = email.split('@');
  return FREE_EMAIL_DOMAINS.has((parts[1] || '').toLowerCase());
}

/**
 * Reject emails that look real but are actually code fragments from minified JS/CSS.
 * Examples: "d@a.js", "fn@file.css", "e@h.map", "x@i.j" (too short overall).
 */
function looksLikeCodeFragment(email: string): boolean {
  const [prefix, domainPart] = email.split('@');
  if (!domainPart) return true;
  // Prefix too short — single-letter variables in minified code
  if (prefix.length < 2) return true;
  // TLD is a file extension
  const tld = domainPart.split('.').pop()?.toLowerCase() || '';
  if (INVALID_TLDS.has(tld)) return true;
  // Domain body (without TLD) too short — real company domains are 3+ chars
  const domainBody = domainPart.slice(0, domainPart.lastIndexOf('.'));
  if (domainBody.length < 3) return true;
  return false;
}

function rankEmail(email: string): number {
  const prefix = email.split('@')[0].toLowerCase();
  if (TOP_PREFIXES.has(prefix)) return 0;
  if (ACCEPTABLE_PREFIXES.has(prefix)) return 1;
  return 2;  // specific/unknown prefix — often a real person, best for cold outreach
}

function extractEmailsFromText(text: string): string[] {
  const emails = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
  for (const m of text.matchAll(OBFUSCATED_RE)) {
    const candidate = `${m[1]}@${m[2]}.${m[3]}`.toLowerCase();
    if (/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(candidate)) emails.add(candidate);
  }
  return [...emails];
}

/**
 * Keep only emails whose domain has real MX records.
 * Code fragments like `cre@ion.here` pass regex + length checks but fail DNS.
 *
 * Behaviour:
 *   - Cache positive hits (has MX) and NODATA/ENOTFOUND (definitely no MX)
 *   - Don't cache transient errors (ETIMEOUT, ECONNREFUSED) — they're network
 *     flakes, not facts about the domain. On transient error, fall back to
 *     accepting the email so we don't drop real candidates.
 */
type MxResult = 'has_mx' | 'no_mx' | 'unknown';
const _mxCache = new Map<string, MxResult>();

async function checkMx(domain: string): Promise<MxResult> {
  const cached = _mxCache.get(domain);
  if (cached) return cached;
  try {
    const records = await _resolver.resolveMx(domain);
    const result: MxResult = records.length > 0 ? 'has_mx' : 'no_mx';
    _mxCache.set(domain, result);
    return result;
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Definitive negative answers — safe to cache and reject
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      _mxCache.set(domain, 'no_mx');
      return 'no_mx';
    }
    // Transient: DNS refused, timeout, etc. — don't reject, don't cache
    return 'unknown';
  }
}

async function filterByMx(emails: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const email of emails) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) continue;
    const mx = await checkMx(domain);
    // Accept anything that isn't a definitive "no MX" answer
    if (mx !== 'no_mx') kept.push(email);
  }
  return kept;
}

/**
 * Recursively walk a parsed JSON-LD object and collect all string values
 * that look like email addresses, or values under keys containing "email".
 */
function extractEmailsFromJsonLd(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const found: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string') {
      // Any key named "email" / "emailAddress" etc.
      if (k.toLowerCase().includes('email') && v.includes('@')) {
        found.push(v.toLowerCase().trim());
      }
      // Also scan string values regardless of key — catches contactPoint.telephone style nesting
      const matches = v.matchAll(EMAIL_RE);
      for (const m of matches) found.push(m[0].toLowerCase());
    } else if (Array.isArray(v)) {
      for (const item of v) found.push(...extractEmailsFromJsonLd(item));
    } else if (v && typeof v === 'object') {
      found.push(...extractEmailsFromJsonLd(v));
    }
  }
  return found;
}

/**
 * Decode a Cloudflare-obfuscated email from a data-cfemail hex string.
 * CF XOR encoding: byte[0] is the key; remaining bytes XOR against it.
 * Returns null if malformed or the result contains no '@'.
 */
function decodeCfEmail(encodedHex: string): string | null {
  try {
    const hex = encodedHex.replace(/\s/g, '');
    if (hex.length < 4 || hex.length % 2 !== 0) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let result = '';
    for (let i = 2; i < hex.length; i += 2) {
      result += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    return result.includes('@') ? result.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function findEmailsOnPage(page: Page): Promise<string[]> {
  const collected = new Set<string>();
  try {
    // ── Strategy A: mailto links + data attributes + body text ──────────────
    const pageData = await page.evaluate(() => {
      const mailtoEmails: string[] = [];
      document.querySelectorAll('a[href^="mailto:"]').forEach((el) => {
        const email = (el as HTMLAnchorElement).href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
        if (email && email.includes('@')) mailtoEmails.push(email);
      });
      const dataAttrEmails: string[] = [];
      document.querySelectorAll('[data-email],[data-mail],[data-contact]').forEach((el) => {
        const v = el.getAttribute('data-email') || el.getAttribute('data-mail') || el.getAttribute('data-contact');
        if (v && v.includes('@')) dataAttrEmails.push(v.toLowerCase().trim());
      });
      const cfRawEmails: string[] = [];
      document.querySelectorAll('[data-cfemail]').forEach((el) => {
        const encoded = el.getAttribute('data-cfemail');
        if (encoded) cfRawEmails.push(encoded);
      });
      return {
        mailtoEmails,
        dataAttrEmails,
        cfRawEmails,
        bodyText: document.body ? document.body.innerText : '',
      };
    });

    pageData.mailtoEmails.forEach((e) => collected.add(e));
    pageData.dataAttrEmails.forEach((e) => collected.add(e));
    for (const encoded of pageData.cfRawEmails) {
      const decoded = decodeCfEmail(encoded);
      if (decoded) collected.add(decoded);
    }
    extractEmailsFromText(pageData.bodyText).forEach((e) => collected.add(e));

    // ── Strategy B: JSON-LD structured data ─────────────────────────────────
    // Schema.org Organization / ContactPoint often embed email here
    const jsonLdBlocks = await page.evaluate(() => {
      const blocks: string[] = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        if (s.textContent?.trim()) blocks.push(s.textContent);
      });
      return blocks;
    });
    for (const block of jsonLdBlocks) {
      try {
        const parsed = JSON.parse(block);
        extractEmailsFromJsonLd(parsed).forEach((e) => collected.add(e));
      } catch { /* malformed JSON-LD — skip */ }
    }

    // ── Strategy C: inline <script> block scanning ──────────────────────────
    // Catches window.__config = { email: "..." } and other inline data blobs.
    // Only scans scripts WITHOUT a src= (external files handled by raw HTML scan).
    const inlineScriptEmails = await page.evaluate(() => {
      const found: string[] = [];
      const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
      document.querySelectorAll('script:not([src])').forEach((s) => {
        const type = (s.getAttribute('type') || '').toLowerCase();
        // JSON-LD already handled above — skip to avoid double-counting
        if (type === 'application/ld+json') return;
        const text = s.textContent || '';
        if (!text.trim()) return;
        const matches = text.matchAll(emailRe);
        for (const m of matches) found.push(m[0].toLowerCase());
      });
      return found;
    });
    inlineScriptEmails.forEach((e) => collected.add(e));

    // ── Strategy D: raw HTML regex ───────────────────────────────────────────
    // Catches emails in HTML comments, encoded attributes, style blocks, etc.
    const html = await page.content();
    extractEmailsFromText(html).forEach((e) => collected.add(e));

  } catch (err) {
    console.log(`    [enricher] email extraction error: ${(err as Error).message.slice(0, 100)}`);
  }

  const preFiltered = [...collected].filter(
    (e) => !isUndeliverable(e) && !isFreeProvider(e) && !looksLikeCodeFragment(e),
  );
  return filterByMx(preFiltered);
}

function pickBestEmail(candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const ra = rankEmail(a);
    const rb = rankEmail(b);
    if (ra !== rb) return ra - rb;
    return a.length - b.length;
  });
  return sorted[0];
}

// ─── Navigation with stealth + challenge handling ───────────────────────────

async function safeGoto(page: Page, url: string, timeout: number): Promise<
  | { ok: true }
  | { ok: false; reason: 'cloudflare_challenge' | 'access_denied' | 'bot_detected' | 'empty_page' | 'nav_error' }
> {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (!response) return { ok: false, reason: 'nav_error' };
    if (response.status() === 403) return { ok: false, reason: 'access_denied' };

    // Give JS-rendered sites a moment to paint
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // Try to auto-resolve CF challenges before classifying as blocked
    await handleCloudflareChallenge(page).catch(() => {});
    await dismissPopups(page);

    const block = await detectBlock(page);
    if (block) return { ok: false, reason: block };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'nav_error' };
  }
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
}

function getDomain(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ─── Sitemap crawl — find real contact/about page URLs ──────────────────────

/**
 * Fetch /sitemap.xml (and /sitemap_index.xml fallback) and extract URLs that
 * look like contact or about pages. Returns up to 5 unique URLs, deduplicated
 * against paths we already plan to check.
 */
async function fetchContactUrlsFromSitemap(
  page: Page,
  baseUrl: string,
  timeout: number,
): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '');
  const sitemapCandidates = [
    `${base}/sitemap.xml`,
    `${base}/sitemap_index.xml`,
    `${base}/sitemap-index.xml`,
  ];

  for (const sitemapUrl of sitemapCandidates) {
    try {
      const resp = await page.goto(sitemapUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 10_000) });
      if (!resp || !resp.ok()) continue;

      const xmlText = await page.evaluate(() => document.body?.innerText || document.documentElement?.innerText || '');
      if (!xmlText.includes('<loc>')) continue;

      // Extract all <loc> URLs
      const locMatches = [...xmlText.matchAll(/<loc>\s*(https?:\/\/[^\s<]+)\s*<\/loc>/gi)];
      const contactUrls: string[] = [];

      for (const m of locMatches) {
        const url = m[1].trim().toLowerCase();
        // Only keep URLs from the same origin
        try {
          const parsed = new URL(url);
          const origin = new URL(base).origin.toLowerCase();
          if (parsed.origin.toLowerCase() !== origin) continue;
        } catch { continue; }

        const path = new URL(url).pathname.toLowerCase();
        const isContact = SITEMAP_CONTACT_KEYWORDS.some((kw) => path.includes(kw));
        if (isContact) {
          // Deduplicate against the static CONTACT_PATHS list
          const alreadyInList = CONTACT_PATHS.some((p) => path === p || path.startsWith(p + '/'));
          if (!alreadyInList) contactUrls.push(m[1].trim());
          if (contactUrls.length >= 5) break;
        }
      }

      if (contactUrls.length > 0) {
        console.log(`    [enricher] sitemap found ${contactUrls.length} contact URL(s)`);
        return contactUrls;
      }
    } catch { /* sitemap not found or malformed — try next */ }
  }
  return [];
}

// ─── Lateral prospecting — affiliate/partner page discovery ─────────────────

/**
 * Scan the currently-loaded page for <a> anchors whose href or visible text
 * matches an affiliate/partner keyword. Resolves to absolute URLs (so a
 * relative '/affiliates' becomes 'https://spinjo.com/affiliates' and an
 * external 'https://roosterpartners.com' is preserved). Dedupes and caps at
 * MAX_AFFILIATE_PROBES so this never balloons the per-lead time budget.
 */
async function findAffiliateUrls(page: Page, baseUrl: string): Promise<string[]> {
  try {
    const raw = await page.evaluate((keywords: string[]) => {
      const out: { href: string }[] = [];
      const re = new RegExp(`\\b(${keywords.join('|')})\\b`, 'i');
      document.querySelectorAll('a[href]').forEach((el) => {
        const a = el as HTMLAnchorElement;
        const href = a.getAttribute('href') || '';
        const text = (a.textContent || '').trim();
        if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) return;
        if (re.test(href) || re.test(text)) out.push({ href: a.href });
      });
      return out;
    }, AFFILIATE_KEYWORDS);

    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const { href } of raw) {
      try {
        const u = new URL(href, baseUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        const norm = u.toString().split('#')[0];
        if (seen.has(norm)) continue;
        seen.add(norm);
        ordered.push(norm);
        if (ordered.length >= MAX_AFFILIATE_PROBES) break;
      } catch { /* skip malformed */ }
    }
    if (ordered.length > 0) {
      console.log(`    [enricher] lateral prospecting — ${ordered.length} affiliate/partner link(s)`);
    }
    return ordered;
  } catch {
    return [];
  }
}

// ─── BP (Brand Page) target detection ──────────────────────────────────────
//
// Casino/affiliate "BP sites" funnel every CTA — Register, Play, Spill, Visit,
// Bonus — at a single external operator domain. The contact info we want is
// at that operator (or further down their JS-redirect chain). Detection is
// language-agnostic: we count external <a href> by registrable domain and
// flag the page as a BP iff one external domain accounts for the vast
// majority of links. The orchestrator then recursively scrapes that target
// through the full tier ladder so Tier 2 can render the JS chain.

const BP_DOMINANT_THRESHOLD = 0.75;  // 75% of external links → BP signal
const BP_MIN_LINKS = 3;              // need at least 3 links to call it dominant
const BP_MAX_DISTINCT_DOMAINS = 3;   // tolerate a handful of social/legal links

// Domains we never treat as BP targets — social, payment, legal, CDN, the
// project's own infrastructure, etc. Keep loose patterns; better to skip a
// real signal than chase a Twitter button.
const BP_TARGET_BLOCKLIST = [
  'trustpilot.com', 'google.com', 'gstatic.com', 'googleapis.com', 'googleadservices.com',
  'doubleclick.net', 'youtube.com', 'youtu.be',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'tiktok.com',
  'pinterest.com', 'reddit.com', 'snapchat.com', 'discord.com', 'discord.gg', 'telegram.org', 't.me',
  'whatsapp.com', 'wa.me', 'medium.com',
  'visa.com', 'mastercard.com', 'paypal.com', 'stripe.com', 'amazon.com',
  'cloudflare.com', 'cloudflareinsights.com', 'jsdelivr.net', 'unpkg.com',
  'wikipedia.org', 'wordpress.org', 'wordpress.com',
  'gambleaware.org', 'gamcare.org.uk', 'begambleaware.org', 'gamblersanonymous.org',
  'spelinspektionen.se', 'lotteritilsynet.no', 'mga.org.mt',
];

async function findBpTarget(page: Page, sourceUrl: string): Promise<string | null> {
  const sourceRegistrable = (() => {
    try { return registrableDomain(new URL(sourceUrl).hostname); } catch { return null; }
  })();
  if (!sourceRegistrable) return null;

  try {
    const hrefs = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('a[href]').forEach((el) => {
        const a = el as HTMLAnchorElement;
        if (a.href && /^https?:/.test(a.href)) out.push(a.href);
      });
      return out;
    });

    const counts = new Map<string, { count: number; firstUrl: string }>();
    let totalExternal = 0;
    for (const href of hrefs) {
      try {
        const reg = registrableDomain(new URL(href).hostname);
        if (!reg || reg === sourceRegistrable) continue;
        if (BP_TARGET_BLOCKLIST.some((b) => reg === b || reg.endsWith(`.${b}`))) continue;
        totalExternal++;
        const slot = counts.get(reg);
        if (slot) slot.count++;
        else counts.set(reg, { count: 1, firstUrl: href });
      } catch { /* skip malformed */ }
    }

    if (counts.size === 0 || counts.size > BP_MAX_DISTINCT_DOMAINS) return null;
    if (totalExternal < BP_MIN_LINKS) return null;

    const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
    const [topDomain, top] = sorted[0];
    const ratio = top.count / totalExternal;
    if (top.count < BP_MIN_LINKS) return null;
    if (ratio < BP_DOMINANT_THRESHOLD) return null;

    console.log(`    [enricher] BP detected — ${top.count}/${totalExternal} external links (${Math.round(ratio * 100)}%) target ${topDomain}`);
    return top.firstUrl;
  } catch {
    return null;
  }
}

// ─── Per-lead enrichment ────────────────────────────────────────────────────

interface ScrapeSiteResult {
  found: string | null;
  candidates?: string[];
  blockReason?: string;
  // Tags which phase produced `found`. 'lateral' means the email came only
  // from an affiliate/partner page reached by following an anchor on the
  // homepage; the route handler writes those to leads.affiliate_email instead
  // of leads.website_email so source provenance is preserved per email.
  source?: 'website' | 'lateral';
  // Set when the live site redirected to a different registrable domain.
  // The orchestrator persists this on the lead row (leads.redirects_to) so
  // the dedicated Redirected Leads page can surface it, and ALSO follows
  // the redirect to scrape the destination — emails found there land in
  // leads.affiliate_email so provenance stays clean.
  redirectsTo?: string;
  // The actual fully-resolved URL the page landed on (e.g. with locale path
  // like /no/registration). Used by the orchestrator to scrape the redirect
  // destination instead of guessing the homepage.
  finalUrl?: string;
  // Set when scrapeSite found no email on the source domain but the homepage
  // is a "BP" (Brand Page / affiliate landing) — i.e. all/most CTAs point at
  // a single external operator domain. The orchestrator then recursively
  // scrapes that target through the full tier ladder; the JS-driven redirect
  // chain (BP → tracker → operator) needs Tier 2 browser rendering to
  // resolve, which a flat HTTP fetch of the BP target can't do alone.
  bpTarget?: string;
}

// Registrable-domain extraction. Multi-level TLDs like .co.uk and .com.au
// need 3 labels; everything else uses the last 2.
function registrableDomain(hostname: string): string {
  const h = hostname.replace(/^www\./, '').toLowerCase();
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const secondLast = parts[parts.length - 2];
  if (secondLast.length <= 3 && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function detectCrossDomainRedirect(sourceUrl: string, finalUrl: string): string | null {
  try {
    const src = registrableDomain(new URL(sourceUrl).hostname);
    const dst = registrableDomain(new URL(finalUrl).hostname);
    if (!src || !dst) return null;
    return src === dst ? null : dst;
  } catch {
    return null;
  }
}

async function scrapeSite(
  page: Page,
  websiteUrl: string,
  timeout: number,
  deadline?: number,
): Promise<ScrapeSiteResult> {
  const url = normalizeUrl(websiteUrl);
  if (!url) return { found: null, blockReason: 'invalid_url' };

  const outOfTime = () => deadline !== undefined && Date.now() > deadline;

  const all = new Set<string>();

  // 1. Homepage — try URL variants before giving up on nav_error
  //    Priority: original → swap protocol → add www. → swap+www.
  function buildVariants(inputUrl: string): string[] {
    const variants = [inputUrl];
    try {
      const parsed = new URL(inputUrl);
      const altProto = parsed.protocol === 'https:'
        ? inputUrl.replace(/^https:\/\//, 'http://')
        : inputUrl.replace(/^http:\/\//, 'https://');
      if (!variants.includes(altProto)) variants.push(altProto);
      if (!parsed.hostname.startsWith('www.')) {
        const withWww = inputUrl.replace(/^(https?:\/\/)/, '$1www.');
        const altWithWww = altProto.replace(/^(https?:\/\/)/, '$1www.');
        if (!variants.includes(withWww)) variants.push(withWww);
        if (!variants.includes(altWithWww)) variants.push(altWithWww);
      }
    } catch { /* malformed URL — original only */ }
    return variants;
  }

  const variants = buildVariants(url);
  let lastReason: string | undefined;
  let navOk = false;
  for (const candidate of variants) {
    if (outOfTime()) break;
    const nav = await safeGoto(page, candidate, timeout);
    if (nav.ok) { navOk = true; break; }
    lastReason = (nav as { ok: false; reason: string }).reason;
    // Only keep retrying on nav_error. If the site actively blocks us
    // (cloudflare/bot/403), a different URL scheme won't help.
    if (lastReason !== 'nav_error') break;
  }
  if (!navOk) {
    // Even when navigation failed, the browser may already be on a different
    // registrable domain — this happens when the source 30x'd to an operator
    // that itself returns 403/CF-challenge. Surface it as a cross-domain
    // redirect so the orchestrator can recursively scrape the operator
    // through tiers that bypass the block (Tier 5 ScrapingBee, ScrapFly).
    let crossDomainTarget: string | null = null;
    let crossDomainFinalUrl: string | undefined;
    try {
      const finalUrl = page.url();
      if (finalUrl && /^https?:/.test(finalUrl)) {
        crossDomainTarget = detectCrossDomainRedirect(url, finalUrl);
        if (crossDomainTarget) crossDomainFinalUrl = finalUrl;
      }
    } catch { /* ignore — page may be in detached state */ }
    if (crossDomainTarget) {
      console.log(`    [enricher] ⤳ ${url} 30x'd to blocked ${crossDomainFinalUrl} (${crossDomainTarget}) — surfacing for follow-tier escalation`);
      return {
        found: null,
        blockReason: 'redirected_off_domain',
        redirectsTo: crossDomainTarget,
        finalUrl: crossDomainFinalUrl,
      };
    }
    return { found: null, blockReason: lastReason ?? 'nav_error' };
  }

  // Detect cross-domain redirects BEFORE extracting any emails. If the source
  // URL silently 30x'd to a different operator's site, we don't want to
  // attribute their info@ address to the original lead. Surface the redirect
  // target so the user can review on the dedicated Redirected Leads page.
  const finalUrl = page.url();
  const redirectTarget = detectCrossDomainRedirect(url, finalUrl);
  if (redirectTarget) {
    console.log(`    [enricher] ⤳ ${url} redirected to ${finalUrl} (${redirectTarget})`);
    return { found: null, blockReason: 'redirected_off_domain', redirectsTo: redirectTarget, finalUrl };
  }

  const homepage = await findEmailsOnPage(page);
  homepage.forEach((e) => all.add(e));

  // Early exit if we already have a top-priority email
  const topNow = [...all].filter((e) => rankEmail(e) === 0);
  if (topNow.length > 0) {
    return { found: pickBestEmail([...all])!, candidates: [...all], source: 'website' };
  }

  // BP (Brand Page) detection — fires RIGHT AFTER the homepage scan, before
  // we burn budget probing 28+ contact paths that on a SPA-driven affiliate
  // landing all return the same shell HTML. If the homepage funnels every
  // CTA at one external operator domain (Trustpilot affiliate-landing
  // pattern), short-circuit and let the orchestrator recursively scrape
  // that target — that's where the contact info actually lives.
  if (all.size === 0 && !outOfTime()) {
    try {
      const bpTarget = await findBpTarget(page, url);
      if (bpTarget) return { found: null, blockReason: 'bp_redirect', bpTarget };
    } catch { /* BP detection best-effort — fall through to normal probing */ }
  }

  // 2. Sitemap-discovered contact URLs (real paths, not guessed)
  if (outOfTime()) {
    const best = pickBestEmail([...all]);
    return best
      ? { found: best, candidates: [...all], source: 'website' }
      : { found: null, blockReason: 'deadline_exceeded' };
  }
  const sitemapUrls = await fetchContactUrlsFromSitemap(page, url, timeout);

  // 3. Combined URL list: sitemap hits first (more likely real), then static guesses
  const urlsToProbe = [
    ...sitemapUrls,
    ...CONTACT_PATHS.map((p) => `${url.replace(/\/$/, '')}${p}`),
  ];

  for (const probeUrl of urlsToProbe) {
    if (outOfTime()) break;
    try {
      const resp = await page.goto(probeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeout, 15_000),
      });
      if (resp && resp.ok()) {
        await dismissPopups(page);
        const emails = await findEmailsOnPage(page);
        emails.forEach((e) => all.add(e));
        // Stop on a top-priority email (contact/hello/sales); if we already have
        // an acceptable one (info/support), we've probably also already paid the
        // expensive probes — continuing rarely finds better.
        if ([...all].some((e) => rankEmail(e) === 0)) break;
        if ([...all].some((e) => rankEmail(e) === 1)) break;
      }
    } catch { /* sub-path miss — try next */ }
    await new Promise((r) => setTimeout(r, 300));
  }

  // 4. Lateral prospecting — affiliate/partner page fallback. Only fires if
  // homepage + sitemap + static contact paths produced nothing. Reuses the
  // already-loaded browser page (no fresh launch). External affiliate domains
  // (e.g. roosterpartners.com from spinjo.com) are followed and the existing
  // findEmailsOnPage extractor runs on them.
  const lateralEmails = new Set<string>();
  if (all.size === 0 && !outOfTime()) {
    try {
      // The contact-path loop above probably navigated us off the homepage.
      // Re-anchor before scanning anchors so we get the homepage's footer/nav.
      const onHomepage = page.url().replace(/\/$/, '') === url.replace(/\/$/, '');
      if (!onHomepage) {
        await safeGoto(page, url, timeout).catch(() => ({ ok: false as const }));
      }
      const affiliateUrls = await findAffiliateUrls(page, url);
      for (const lateralUrl of affiliateUrls) {
        if (outOfTime()) break;
        try {
          const nav = await safeGoto(page, lateralUrl, Math.min(timeout, 20_000));
          if (!nav.ok) continue;
          const found = await findEmailsOnPage(page);
          found.forEach((e) => { lateralEmails.add(e); all.add(e); });
          if ([...lateralEmails].some((e) => rankEmail(e) === 0)) break;
          if ([...lateralEmails].some((e) => rankEmail(e) === 1)) break;
        } catch (err) {
          console.log(`    [enricher] lateral probe failed (${lateralUrl}): ${(err as Error).message.slice(0, 80)}`);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (err) {
      console.log(`    [enricher] lateral prospecting error: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  const best = pickBestEmail([...all]);
  if (!best) {
    // BP detection — if the homepage funnels every CTA at one external
    // operator domain, surface that target so the orchestrator can scrape
    // it through the full tier ladder. The chain (BP → tracker → operator)
    // typically needs Tier 2 browser to follow JS redirects, so flat-HTTP
    // probes of the BP target alone usually return a verification stub.
    if (!outOfTime()) {
      try {
        const onHomepage = page.url().replace(/\/$/, '') === url.replace(/\/$/, '');
        if (!onHomepage) await safeGoto(page, url, timeout).catch(() => ({ ok: false as const }));
        const bpTarget = await findBpTarget(page, url);
        if (bpTarget) return { found: null, blockReason: 'bp_redirect', bpTarget };
      } catch { /* BP detection best-effort — fall through to no-email */ }
    }
    return { found: null };
  }
  // Tag lateral only when the best email appeared exclusively on an affiliate
  // page (not also on the homepage). Sites that publish the same address on
  // their main domain stay tagged as 'website'.
  const fromLateralOnly = lateralEmails.has(best) && !homepage.includes(best);
  return { found: best, candidates: [...all], source: fromLateralOnly ? 'lateral' : 'website' };
}

// ─── Tier escalation ────────────────────────────────────────────────────────

const BLOCK_REASONS_THAT_ESCALATE = new Set([
  'cloudflare_challenge', 'access_denied', 'bot_detected', 'empty_page',
]);

// Hard per-lead time budget. Without this a single slow site (Cloudflare
// challenge loops, 28 contact paths each timing out at 15s) could stall a
// worker for >7 minutes, blowing the Cloud Run 60-min request limit on
// larger batches. Bumped from 150s → 240s once Tier 1.5 (curl_cffi),
// premium→stealth ScrapingBee retry, and ScrapFly were added — sequential
// worst case is now Tier 1.5 (~30s) + Tier 2 (~30s) + Tier 5 premium (~70s)
// + Tier 5 stealth retry (~70s) + Tier 5b ScrapFly (~30s) ≈ 230s. We give
// the budget enough headroom that the slowest path still completes; the
// per-domain tier cache below means most leads finish in well under 30s.
const PER_LEAD_BUDGET_MS = 240_000;

// ─── Per-domain tier cache ──────────────────────────────────────────────────
//
// Process-local memo of which tier last produced a result for a given
// registrable domain. Lets a follow-up lead from the same operator skip the
// tiers we already know don't work. Cleared on process restart — no
// persistence, no cross-process sharing. Keep it small; cap entries to bound
// memory.
type CachedTierKey =
  | 'tier1_5_tls' | 'tier2' | 'tier3' | 'tier4'
  | 'scrapingbee_premium' | 'scrapingbee_stealth' | 'scrapfly'
  | 'whois' | 'wayback' | 'crtsh' | 'hunter'
  | 'cloudflare_blocked' | 'redirected_off_domain' | 'no_email';

interface DomainTierMemo {
  /** Tier that last produced an email for this domain (if any). */
  workingTier?: CachedTierKey;
  /** Last block reason observed — used to fast-track escalation. */
  lastBlockReason?: string;
  /** Timestamp; entries older than 30 minutes are ignored (sites recover). */
  ts: number;
}

const _domainTierCache = new Map<string, DomainTierMemo>();
const DOMAIN_CACHE_MAX_ENTRIES = 1000;
const DOMAIN_CACHE_TTL_MS = 30 * 60_000;

function registrableDomainOf(websiteUrl: string): string {
  try {
    const u = new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`);
    const host = u.hostname.replace(/^www\./, '');
    return host.toLowerCase();
  } catch {
    return websiteUrl.toLowerCase();
  }
}

function getDomainMemo(websiteUrl: string): DomainTierMemo | undefined {
  const key = registrableDomainOf(websiteUrl);
  const memo = _domainTierCache.get(key);
  if (!memo) return undefined;
  if (Date.now() - memo.ts > DOMAIN_CACHE_TTL_MS) {
    _domainTierCache.delete(key);
    return undefined;
  }
  return memo;
}

function setDomainMemo(websiteUrl: string, memo: Omit<DomainTierMemo, 'ts'>): void {
  const key = registrableDomainOf(websiteUrl);
  // Bound the cache — drop oldest when full (FIFO via insertion order).
  if (_domainTierCache.size >= DOMAIN_CACHE_MAX_ENTRIES) {
    const oldestKey = _domainTierCache.keys().next().value;
    if (oldestKey) _domainTierCache.delete(oldestKey);
  }
  _domainTierCache.set(key, { ...memo, ts: Date.now() });
}

/**
 * Lightweight HTTP/HTTPS fast lane: attempts a raw GET of the homepage and
 * /contact using node:https/node:http builtins — no browser, no stealth.
 * Works for static HTML sites where the email is already in the source.
 * Returns the best email found, or null.
 */
async function httpFastLane(websiteUrl: string): Promise<string | null> {
  const url = normalizeUrl(websiteUrl);
  if (!url) return null;

  const FAST_LANE_TIMEOUT_MS = 5_000;
  const FAST_LANE_MAX_BYTES = 500_000;

  async function fetchRaw(targetUrl: string, redirectsLeft = 1): Promise<string | null> {
    return new Promise((resolve) => {
      const parsed = (() => { try { return new URL(targetUrl); } catch { return null; } })();
      if (!parsed) return resolve(null);
      const lib = parsed.protocol === 'https:' ? https : http;
      let resolved = false;
      const finish = (v: string | null) => { if (!resolved) { resolved = true; resolve(v); } };
      const req = lib.get(
        targetUrl,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Accept': 'text/html,application/xhtml+xml',
          },
          timeout: FAST_LANE_TIMEOUT_MS,
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) return finish(null);
            const next = new URL(res.headers.location, targetUrl).toString();
            fetchRaw(next, redirectsLeft - 1).then(finish).catch(() => finish(null));
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            res.resume();
            return finish(null);
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > FAST_LANE_MAX_BYTES) req.destroy();
          });
          res.on('end', () => finish(body));
          res.on('error', () => finish(null));
        },
      );
      req.on('timeout', () => { req.destroy(); finish(null); });
      req.on('error', () => finish(null));
    });
  }

  const urlsToTry = [url, `${url.replace(/\/$/, '')}/contact`];
  const all = new Set<string>();

  for (const probe of urlsToTry) {
    const body = await fetchRaw(probe);
    if (!body) continue;
    extractEmailsFromText(body).forEach((e) => all.add(e));
    const cfPattern = /data-cfemail="([0-9a-fA-F]+)"/g;
    for (const m of body.matchAll(cfPattern)) {
      const decoded = decodeCfEmail(m[1]);
      if (decoded) all.add(decoded);
    }
    if (all.size > 0) break;
  }

  const candidates = [...all].filter(
    (e) => !isUndeliverable(e) && !isFreeProvider(e) && !looksLikeCodeFragment(e),
  );
  if (candidates.length === 0) return null;
  const verified = await filterByMx(candidates);
  return pickBestEmail(verified);
}

/**
 * Run Tier 5 (ScrapingBee) against a URL and return the best email found, or null.
 * Tries homepage and /contact via the managed proxy, then runs the same
 * extraction pipeline (regex + obfuscation + Cloudflare decode + MX filter)
 * we use on browser-rendered HTML.
 */
// Pages to probe via ScrapingBee in priority order. Direct API smoke tests
// confirmed ScrapingBee returns 200 + real HTML in 5–12s for Cloudflare-blocked
// sites, so the cost of probing multiple paths is bounded and worth the lift.
// Order matters — homepage first (cheapest signal), then dedicated contact
// pages, then legal/regulatory pages where licensed operators are required to
// publish operator contact info (the casino industry's only reliable source).
const TIER5_PROBE_PATHS = [
  '',                  // homepage
  '/contact',          // EN — most common
  '/kontakt',          // DA/DE/NO/SV — covers Nordic/German casino market
  '/impressum',        // DE — legally mandated contact info
  '/about',            // EN fallback
];
// Hard cap on Tier 5 calls per lead — each call is ~25 credits with
// premium_proxy + render_js. 4 caps blocked-lead cost at ~100 credits.
const TIER5_MAX_PROBES = 4;
// Stealth_proxy costs ~75 credits per call (3x premium), so cap retries tighter:
// only re-probe homepage + /contact under stealth — those two cover the
// realistic email locations on Cloudflare-blocked operator sites.
const TIER5_MAX_STEALTH_PROBES = 2;

// Markers that the returned HTML is itself a Cloudflare interstitial — i.e.
// premium_proxy got 200 OK but Cloudflare served the challenge page through
// it. These are the same strings popup-handler.ts uses to detect blocks in
// browser-rendered HTML; reusing them keeps detection consistent across tiers.
const CF_HTML_MARKERS = [
  'just a moment',
  'checking your browser',
  'cf-browser-verification',
  'attention required',
  'enable javascript and cookies',
  'ddos protection by cloudflare',
];

function htmlLooksCloudflareBlocked(html: string): boolean {
  const lower = html.toLowerCase();
  return CF_HTML_MARKERS.some((marker) => lower.includes(marker));
}

async function tier5ScrapingbeeScan(
  websiteUrl: string,
  country?: string,
): Promise<{ email: string | null; usedStealth: boolean; probes: number }> {
  const url = normalizeUrl(websiteUrl);
  if (!url) return { email: null, usedStealth: false, probes: 0 };

  const countryCode = countryNameToIso2(country);
  const base = url.replace(/\/$/, '');
  const all = new Set<string>();
  let premiumProbes = 0;
  let stealthProbes = 0;
  let everSawCfBlock = false;

  // ── Pass 1: premium_proxy across all probe paths (cheap tier) ──
  for (const subpath of TIER5_PROBE_PATHS) {
    if (premiumProbes >= TIER5_MAX_PROBES) break;
    const target = subpath ? `${base}${subpath}` : url;
    premiumProbes++;

    const html = await fetchViaScrapingbee(target, {
      renderJs: true,
      premiumProxy: true,
      blockResources: false,
      countryCode,
    });
    if (!html) continue;

    // ScrapingBee returned HTML but it's a Cloudflare challenge page — the
    // premium pool is on the target's blocklist. Note this so we escalate
    // to stealth_proxy, but keep collecting any emails the page might leak
    // (CF challenge pages are rarely useful, but it's free to scan).
    if (htmlLooksCloudflareBlocked(html)) {
      everSawCfBlock = true;
      continue;
    }

    extractEmailsFromText(html).forEach((e) => all.add(e));
    const cfPattern = /data-cfemail="([0-9a-fA-F]+)"/g;
    for (const m of html.matchAll(cfPattern)) {
      const decoded = decodeCfEmail(m[1]);
      if (decoded) all.add(decoded);
    }

    const cleanNow = [...all].filter(
      (e) => !isUndeliverable(e) && !isFreeProvider(e) && !looksLikeCodeFragment(e),
    );
    if (cleanNow.some((e) => rankEmail(e) === 0)) break;
  }

  let cleanedSoFar = [...all].filter(
    (e) => !isUndeliverable(e) && !isFreeProvider(e) && !looksLikeCodeFragment(e),
  );
  const haveTopHit = cleanedSoFar.some((e) => rankEmail(e) === 0);

  // ── Pass 2: escalate to stealth_proxy if premium leaked nothing useful ──
  // Trigger when premium HTML was a CF challenge OR when premium produced no
  // top-priority email AND no candidates at all. Don't burn stealth credits
  // when we already have a usable info@/contact@ candidate.
  const shouldEscalate =
    !haveTopHit && (everSawCfBlock || cleanedSoFar.length === 0);

  if (shouldEscalate) {
    const stealthPaths = TIER5_PROBE_PATHS.slice(0, TIER5_MAX_STEALTH_PROBES);
    for (const subpath of stealthPaths) {
      stealthProbes++;
      const target = subpath ? `${base}${subpath}` : url;

      const html = await fetchViaScrapingbee(target, {
        renderJs: true,
        stealthProxy: true,
        blockResources: false,
        countryCode,
      });
      if (!html) continue;
      if (htmlLooksCloudflareBlocked(html)) continue; // even stealth blocked — give up

      extractEmailsFromText(html).forEach((e) => all.add(e));
      const cfPattern = /data-cfemail="([0-9a-fA-F]+)"/g;
      for (const m of html.matchAll(cfPattern)) {
        const decoded = decodeCfEmail(m[1]);
        if (decoded) all.add(decoded);
      }

      cleanedSoFar = [...all].filter(
        (e) => !isUndeliverable(e) && !isFreeProvider(e) && !looksLikeCodeFragment(e),
      );
      if (cleanedSoFar.some((e) => rankEmail(e) === 0)) break;
    }
  }

  const totalProbes = premiumProbes + stealthProbes;
  const usedStealth = stealthProbes > 0;
  const candidates = [...all].filter(
    (e) => !isUndeliverable(e) && !isFreeProvider(e) && !looksLikeCodeFragment(e),
  );
  if (candidates.length === 0) {
    console.log(`    [tier5] no email after ${premiumProbes} premium + ${stealthProbes} stealth probe(s)${countryCode ? ` (country=${countryCode})` : ''}`);
    return { email: null, usedStealth, probes: totalProbes };
  }
  const verified = await filterByMx(candidates);
  const best = pickBestEmail(verified);
  if (best) {
    console.log(`    [tier5${usedStealth ? ':stealth' : ''}] hit after ${premiumProbes}+${stealthProbes} probe(s): ${best}`);
  }
  return { email: best, usedStealth, probes: totalProbes };
}

/**
 * Tier 5b — ScrapFly managed-proxy scan. Mirrors Tier 5's probe loop but uses
 * a different vendor (different IP pool + different anti-bot infra), so this
 * is the natural follow-on when ScrapingBee can't get through.
 */
const TIER5B_PROBE_PATHS = ['', '/contact', '/kontakt', '/impressum'];
const TIER5B_MAX_PROBES = 3;

async function tier5bScrapflyScan(
  websiteUrl: string,
  country?: string,
): Promise<string | null> {
  const url = normalizeUrl(websiteUrl);
  if (!url) return null;

  const countryCode = countryNameToIso2(country);
  const base = url.replace(/\/$/, '');
  const all = new Set<string>();
  let probes = 0;

  for (const subpath of TIER5B_PROBE_PATHS) {
    if (probes >= TIER5B_MAX_PROBES) break;
    const target = subpath ? `${base}${subpath}` : url;
    probes++;

    const html = await fetchViaScrapfly(target, {
      renderJs: true,
      asp: true,
      countryCode,
    });
    if (!html) continue;
    if (htmlLooksCloudflareBlocked(html)) continue;

    extractEmailsFromText(html).forEach((e) => all.add(e));
    const cfPattern = /data-cfemail="([0-9a-fA-F]+)"/g;
    for (const m of html.matchAll(cfPattern)) {
      const decoded = decodeCfEmail(m[1]);
      if (decoded) all.add(decoded);
    }

    const cleanNow = [...all].filter(
      (e) => !isUndeliverable(e) && !isFreeProvider(e) && !looksLikeCodeFragment(e),
    );
    if (cleanNow.some((e) => rankEmail(e) === 0)) break;
  }

  const candidates = [...all].filter(
    (e) => !isUndeliverable(e) && !isFreeProvider(e) && !looksLikeCodeFragment(e),
  );
  if (candidates.length === 0) {
    console.log(`    [tier5b] no email after ${probes} probe(s)${countryCode ? ` (country=${countryCode})` : ''}`);
    return null;
  }
  const verified = await filterByMx(candidates);
  const best = pickBestEmail(verified);
  if (best) console.log(`    [tier5b] hit after ${probes} probe(s): ${best}`);
  return best;
}

/**
 * Tier 1.5 — Chrome-TLS-fingerprint HTTP fetch via curl_cffi subprocess.
 * Same email-extraction pipeline as the browser path, but no browser launch.
 * Returns the best email + a flag indicating whether the TLS fetch saw
 * Cloudflare blocks (used by callers to decide whether to escalate).
 */
async function tier1_5TlsScan(
  websiteUrl: string,
): Promise<{ email: string | null; sawCfBlock: boolean; ran: boolean }> {
  const result = await tier1_5TlsFetch(websiteUrl);
  if (!result) return { email: null, sawCfBlock: false, ran: false };

  const all = new Set<string>();
  let sawCfBlock = false;

  for (const probe of result.probes) {
    if (probe.blockReason === 'cloudflare_challenge') sawCfBlock = true;
    if (!probe.html) continue;
    extractEmailsFromText(probe.html).forEach((e) => all.add(e));
    const cfPattern = /data-cfemail="([0-9a-fA-F]+)"/g;
    for (const m of probe.html.matchAll(cfPattern)) {
      const decoded = decodeCfEmail(m[1]);
      if (decoded) all.add(decoded);
    }
  }

  const candidates = [...all].filter(
    (e) => !isUndeliverable(e) && !isFreeProvider(e) && !looksLikeCodeFragment(e),
  );
  if (candidates.length === 0) {
    console.log(`    [tier1_5_tls] ran ${result.probes.length} probe(s), no usable email${sawCfBlock ? ' (CF block seen)' : ''}`);
    return { email: null, sawCfBlock, ran: true };
  }
  const verified = await filterByMx(candidates);
  const best = pickBestEmail(verified);
  if (best) console.log(`    [tier1_5_tls] hit (impersonate=${result.impersonate}): ${best}`);
  return { email: best, sawCfBlock, ran: true };
}

async function enrichSingleLeadWithTiers(
  websiteUrl: string,
  opts: {
    startTier?: Tier;
    country?: string | null;
    /**
     * Allow one cross-domain 30x redirect at homepage load to be followed
     * (recursive scrape of destination, result marked 'lateral'). Default
     * true; recursive calls set this to false to bound the chain.
     */
    followRedirect?: boolean;
    /**
     * Allow one BP-redirect to be followed: when the source domain funnels
     * every CTA at one external operator domain (Trustpilot affiliate
     * landing pattern), recursively scrape the operator. Independent from
     * followRedirect so a BP target is still allowed to do a single
     * cross-domain redirect (BP → tracker → operator). Default true;
     * recursive calls set this to false to prevent BP→BP→... nesting.
     */
    followBp?: boolean;
    /**
     * Inherited deadline (ms epoch) for recursive scrapes. Caps total
     * wall-clock at the original lead's PER_LEAD_BUDGET_MS rather than
     * doubling/tripling it for chained follow-ups.
     */
    inheritedDeadline?: number;
  } = {},
): Promise<{
  email: string | null;
  tier: Tier | 'scrapingbee' | 'scrapfly' | 'whois' | 'wayback' | 'crtsh' | 'hunter' | 'redirected' | 'none';
  blockReason?: string;
  redirectsTo?: string;
  // Set when the in-tier scrapeSite() reports the email came from a lateral
  // affiliate/partner page rather than the main domain. Used by the route
  // handler to decide whether to write to leads.affiliate_email or
  // leads.website_email. Only meaningful when `email` is non-null and
  // `tier` is one of 2/3/4 (i.e. the browser path produced the hit).
  scrapeSource?: 'website' | 'lateral';
}> {
  const startTier: Tier = opts.startTier ?? 2;
  const country = opts.country ?? null;
  const followRedirect = opts.followRedirect ?? true;
  const followBp = opts.followBp ?? true;
  const deadline = opts.inheritedDeadline ?? (Date.now() + PER_LEAD_BUDGET_MS);

  // Per-domain memo lookup — if we've enriched this domain in the last 30
  // minutes, use what we learned to skip tiers that don't work and fast-track
  // ones that do. Saves both time and ScrapingBee credits when many leads from
  // the same operator come in (common in casino/affiliate networks).
  const memo = getDomainMemo(websiteUrl);
  let seenCfChallenge = false;

  const availableTiers: Tier[] = [];
  for (const t of [startTier, 3, 4] as Tier[]) {
    if (t === startTier || !availableTiers.includes(t)) {
      if (t === 3 && !process.env.SCRAPER_DC_PROXY_URL) continue;
      if (t === 4 && !process.env.SCRAPER_RES_PROXY_URL) continue;
      availableTiers.push(t);
    }
  }

  // If memo says this domain is Cloudflare-blocked, pre-set the flag so the
  // browser-tier loop skips Tier 3 (DC proxy is useless against CF) and we
  // jump faster toward Tier 5 stealth + Tier 5b ScrapFly.
  if (memo?.lastBlockReason === 'cloudflare_challenge') {
    seenCfChallenge = true;
  }

  // HTTP fast lane — try raw GET before paying browser-launch cost
  if (Date.now() < deadline) {
    try {
      const fastEmail = await httpFastLane(websiteUrl);
      if (fastEmail) {
        setDomainMemo(websiteUrl, { workingTier: 'tier2', lastBlockReason: undefined });
        console.log(`    [enricher] ✓ fast-lane hit: ${fastEmail}`);
        return { email: fastEmail, tier: 2 };
      }
    } catch { /* best-effort — fall through to browser path */ }
  }

  // Tier 1.5 — Chrome-TLS-fingerprint HTTP via curl_cffi. Bypasses
  // Cloudflare's TLS-handshake fingerprint check on a large fraction of
  // protected sites without launching a browser. Free, fast (~1-3s/probe).
  // Skips silently if curl_cffi isn't installed.
  if (Date.now() < deadline) {
    try {
      const { email: tlsEmail, sawCfBlock, ran } = await tier1_5TlsScan(websiteUrl);
      if (tlsEmail) {
        setDomainMemo(websiteUrl, { workingTier: 'tier1_5_tls', lastBlockReason: undefined });
        return { email: tlsEmail, tier: 2 };
      }
      // No email but TLS fetch saw a CF challenge — flag for the escalation
      // logic below so we skip Tier 3 (DC proxy) and head straight to Tier 5.
      if (ran && sawCfBlock) seenCfChallenge = true;
    } catch { /* tier 1.5 is best-effort — fall through */ }
  }

  let lastBlockReason: string | undefined = seenCfChallenge ? 'cloudflare_challenge' : undefined;
  for (const tier of availableTiers) {
    if (Date.now() > deadline) { lastBlockReason = 'per_lead_deadline'; break; }
    // Datacenter-proxy IPs are pre-flagged by Cloudflare's bot-management.
    // If we already know this domain serves a CF challenge, skipping Tier 3
    // saves ~5-45s of wasted timeout and gets us to Tier 5 stealth faster.
    if (tier === 3 && seenCfChallenge) {
      console.log(`    [enricher] skipping tier 3 — Cloudflare challenge detected, DC proxy won't help`);
      continue;
    }
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      const bundle = await launchBrowser(TIER_CONFIGS[tier]);
      browser = bundle.browser;
      context = bundle.context;
      const page = await context.newPage();
      const result = await scrapeSite(page, websiteUrl, TIER_CONFIGS[tier].timeout, deadline);
      if (result.found) {
        setDomainMemo(websiteUrl, {
          workingTier: tier === 2 ? 'tier2' : tier === 3 ? 'tier3' : 'tier4',
          lastBlockReason: undefined,
        });
        return { email: result.found, tier, scrapeSource: result.source };
      }
      // BP (Brand Page) detection: the source domain is itself an affiliate
      // landing page that funnels every CTA at one external operator. Follow
      // the operator URL and scrape there — emails land in affiliate_email
      // since the address belongs to the operator, not the BP brand. We
      // ALSO surface redirectsTo (the operator's registrable domain) so the
      // lead appears on the Redirected Leads page and the user can review
      // the operator-context handoff before approving outreach.
      if (result.blockReason === 'bp_redirect' && result.bpTarget && followBp && Date.now() < deadline) {
        console.log(`    [enricher] BP redirect — scraping operator at ${result.bpTarget} (saving as affiliate_email)`);
        // Compute the BP target's registrable domain up front so we can
        // surface it as redirectsTo whether or not the recursive scrape
        // turns up an email. Same domain shows on the Redirected Leads
        // page in both cases.
        let bpTargetDomain: string | undefined;
        try { bpTargetDomain = registrableDomain(new URL(result.bpTarget).hostname); } catch { /* malformed URL — skip */ }
        try {
          // Allow ONE more cross-domain redirect at the BP target (chain is
          // typically BP → tracker → operator; we want to land on the
          // operator). Don't allow further BP detection from this hop.
          const inner = await enrichSingleLeadWithTiers(result.bpTarget, {
            country,
            followRedirect: true,
            followBp: false,
            inheritedDeadline: deadline,
          });
          if (inner.email) {
            return {
              email: inner.email,
              tier: inner.tier,
              scrapeSource: 'lateral',
              redirectsTo: inner.redirectsTo ?? bpTargetDomain,
            };
          }
          // BP target had no email either — surface what we know. The route
          // still writes leads.redirects_to from this so the lead is visible
          // on the Redirected Leads page even with no email scraped.
          if (bpTargetDomain) {
            lastBlockReason = 'redirected_off_domain';
            return {
              email: null,
              tier: 'redirected',
              redirectsTo: inner.redirectsTo ?? bpTargetDomain,
              blockReason: 'redirected_off_domain',
            };
          }
          lastBlockReason = 'bp_redirect_no_email';
        } catch (err) {
          console.warn(`    [enricher] BP-follow error: ${(err as Error).message.slice(0, 100)}`);
        }
        // Don't fall through to the cross-domain redirect block — different signal.
        continue;
      }

      // Cross-domain redirect: stop tier escalation on the source domain (any
      // emails scraped there belong to a different operator), but follow the
      // redirect once and scrape the destination — those hits are written to
      // leads.affiliate_email so provenance stays clean. The original
      // `redirectsTo` is preserved on the return so the route still writes
      // leads.redirects_to for the Redirected Leads page.
      if (result.redirectsTo) {
        setDomainMemo(websiteUrl, { lastBlockReason: 'redirected_off_domain' });
        const redirectTarget = result.redirectsTo;
        const finalUrl = result.finalUrl;

        if (followRedirect && finalUrl && Date.now() < deadline) {
          console.log(`    [enricher] following redirect → ${finalUrl} (saving as affiliate_email if found)`);
          try {
            const inner = await enrichSingleLeadWithTiers(finalUrl, {
              country,
              followRedirect: false,
              followBp: false,
              inheritedDeadline: deadline,
            });
            // Whether the inner scrape found an email or not, we keep the
            // original redirect target on the result so the route writes
            // leads.redirects_to. If an email was found, force source to
            // 'lateral' so it writes to affiliate_email rather than
            // website_email — the address belongs to the destination
            // operator, not the original lead's brand.
            return {
              email: inner.email,
              tier: inner.email ? inner.tier : 'redirected',
              blockReason: inner.email ? undefined : 'redirected_off_domain',
              redirectsTo: redirectTarget,
              scrapeSource: inner.email ? 'lateral' : undefined,
            };
          } catch (err) {
            console.warn(`    [enricher] redirect-follow error: ${(err as Error).message.slice(0, 100)}`);
          }
        }

        // followRedirect=false (recursive call) or no finalUrl available —
        // fall through to the original behavior: surface the redirect, no
        // email scraped.
        return { email: null, tier: 'redirected', redirectsTo: redirectTarget, blockReason: 'redirected_off_domain' };
      }
      const reason = result.blockReason ?? undefined;
      lastBlockReason = reason || lastBlockReason;
      if (reason === 'cloudflare_challenge') seenCfChallenge = true;
      if (!reason || !BLOCK_REASONS_THAT_ESCALATE.has(reason)) {
        break;  // page loaded fine, just no emails — escalation won't help
      }
    } catch (err) {
      lastBlockReason = `error:${(err as Error).message.slice(0, 100)}`;
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  // Tier 5 — ScrapingBee managed-proxy fallback. Only triggers if the API key
  // is configured, the cheaper tiers were blocked (not just empty), and we
  // still have time left in the per-lead budget.
  const wasBlocked = lastBlockReason !== undefined
    && (BLOCK_REASONS_THAT_ESCALATE.has(lastBlockReason) || lastBlockReason.startsWith('error:'));
  if (scrapingbeeEnabled() && wasBlocked && Date.now() < deadline) {
    try {
      console.log(`    [enricher] tier5 (ScrapingBee) — escalating after ${lastBlockReason}`);
      const { email: sbEmail, usedStealth } = await tier5ScrapingbeeScan(websiteUrl, country ?? undefined);
      if (sbEmail) {
        setDomainMemo(websiteUrl, {
          workingTier: usedStealth ? 'scrapingbee_stealth' : 'scrapingbee_premium',
          lastBlockReason: undefined,
        });
        return { email: sbEmail, tier: 'scrapingbee' };
      }
    } catch (err) {
      console.warn(`    [enricher] tier5 error: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // Tier 5b — ScrapFly fallback. Different IP pool + different anti-bot
  // infrastructure than ScrapingBee, so domains that block one tier often
  // clear the other. Free tier is 1,000 credits/month, permanent.
  if (scrapflyEnabled() && wasBlocked && Date.now() < deadline) {
    try {
      console.log(`    [enricher] tier5b (ScrapFly) — escalating after ScrapingBee miss`);
      const sfEmail = await tier5bScrapflyScan(websiteUrl, country ?? undefined);
      if (sfEmail) {
        setDomainMemo(websiteUrl, { workingTier: 'scrapfly', lastBlockReason: undefined });
        return { email: sfEmail, tier: 'scrapfly' };
      }
    } catch (err) {
      console.warn(`    [enricher] tier5b error: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // Tier 6 — WHOIS registrant lookup. Most modern domains are GDPR-redacted
  // so this rarely fires, but it's free, fast, and occasionally surfaces a
  // real operator email on older domains or non-EU ccTLDs.
  if (Date.now() < deadline) {
    try {
      const { email: whoisEmail } = await tier6WhoisLookup(websiteUrl);
      if (whoisEmail) {
        setDomainMemo(websiteUrl, { workingTier: 'whois', lastBlockReason: undefined });
        return { email: whoisEmail, tier: 'whois' };
      }
    } catch (err) {
      console.warn(`    [enricher] tier6 error: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // Tier 7 — Wayback Machine. Older snapshots of the contact/about pages
  // often still have a plain mailto: that the live site has since stripped.
  if (Date.now() < deadline) {
    try {
      const { email: wbEmail } = await tier7WaybackLookup(websiteUrl, deadline);
      if (wbEmail) {
        setDomainMemo(websiteUrl, { workingTier: 'wayback', lastBlockReason: undefined });
        return { email: wbEmail, tier: 'wayback' };
      }
    } catch (err) {
      console.warn(`    [enricher] tier7 error: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // Tier 8 — crt.sh certificate transparency. Last-gasp scan of historical
  // TLS cert subjects/SANs for embedded admin emails.
  if (Date.now() < deadline) {
    try {
      const { email: ctEmail } = await tier8CrtshLookup(websiteUrl);
      if (ctEmail) {
        setDomainMemo(websiteUrl, { workingTier: 'crtsh', lastBlockReason: undefined });
        return { email: ctEmail, tier: 'crtsh' };
      }
    } catch (err) {
      console.warn(`    [enricher] tier8 error: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // Tier 9 — Hunter.io domain-search. No scraping, just an aggregated public-
  // sources lookup, so it works even on fully Cloudflare-blocked domains.
  // Free tier: 50/month — only triggers after every other tier has missed.
  if (hunterEnabled() && Date.now() < deadline) {
    try {
      const { email: hEmail } = await tier9HunterLookup(websiteUrl);
      if (hEmail) {
        setDomainMemo(websiteUrl, { workingTier: 'hunter', lastBlockReason: undefined });
        return { email: hEmail, tier: 'hunter' };
      }
    } catch (err) {
      console.warn(`    [enricher] tier9 error: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // No MX-guess fallback — if real scraping found nothing, return null.
  // Guessed emails (info@<domain>) polluted the DB with addresses that look
  // legitimate but were never actually verified to exist on the page.
  setDomainMemo(websiteUrl, { lastBlockReason: lastBlockReason ?? 'no_email' });
  return { email: null, tier: 'none', blockReason: lastBlockReason };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface EnrichableLead {
  id?: string;
  trustpilot_url?: string;
  website_url?: string | null;
  website_email?: string | null;
  [k: string]: unknown;
}

export interface EnrichmentResult {
  lead: EnrichableLead;
  foundEmail: string | null;
  // 'lateral' = email came from a followed affiliate/partner page (writes to
  // leads.affiliate_email). 'scrape' = main-domain scrape or any other tier
  // (writes to leads.website_email). 'none' = no email found.
  source: 'scrape' | 'lateral' | 'none';
  tier: Tier | 'scrapingbee' | 'scrapfly' | 'whois' | 'wayback' | 'crtsh' | 'hunter' | 'redirected' | 'none';
  blockReason?: string;
  redirectsTo?: string;
}

/**
 * A structured per-item event emitted by the enricher. Callers (scrape-runner,
 * /api/enrich route) subscribe to translate these into SSE + scrape_failures rows.
 */
export type EnricherEvent =
  | { type: 'enrich_start'; index: number; total: number; domain: string; leadId?: string }
  // enrich_email carries everything the route needs to write the lead row
  // immediately (per-lead inline writes), so partial progress survives if
  // the worker dies mid-job — no more "Yazino was found but never saved"
  // problems on Cloud Run instance rotations.
  | { type: 'enrich_email'; index: number; total: number; domain: string; email: string; tier: string; leadId?: string; source: 'scrape' | 'lateral'; redirectsTo?: string }
  | { type: 'enrich_no_email'; index: number; total: number; domain: string; reason?: string; leadId?: string }
  | { type: 'enrich_redirected'; index: number; total: number; domain: string; redirectsTo: string; leadId?: string }
  | { type: 'enrich_failed'; index: number; total: number; domain: string; reasonCode: string; message: string; leadId?: string };

function domainOf(url: string): string {
  const stripped = url.replace(/^https?:\/\//, '').split('/')[0] || url;
  return stripped.replace(/^www\./, '');
}

export async function enrichLeads(
  leads: EnrichableLead[],
  opts: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    onEvent?: (event: EnricherEvent) => void;
  } = {},
): Promise<EnrichmentResult[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 5));

  // Filter out leads that can't be enriched
  const queue = leads
    .map((l, idx) => ({ idx, lead: l }))
    .filter(({ lead }) => lead.website_url && !lead.website_email);

  const results: EnrichmentResult[] = leads.map((lead) => ({
    lead,
    foundEmail: null,
    source: 'none',
    tier: 'none',
  }));

  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < queue.length) {
      const i = cursor++;
      const { idx, lead } = queue[i];
      const websiteUrl = lead.website_url!;
      const domain = domainOf(websiteUrl);
      const itemIndex = i + 1;

      const leadId = (lead as { id?: string }).id;
      console.log(`  [enricher] [${done + 1}/${queue.length}] ${websiteUrl}`);
      opts.onEvent?.({ type: 'enrich_start', index: itemIndex, total: queue.length, domain, leadId });
      try {
        const country = (lead.country as string | null | undefined) ?? null;
        const { email, tier, blockReason, redirectsTo, scrapeSource } = await enrichSingleLeadWithTiers(websiteUrl, { country });
        const resolvedSource: 'scrape' | 'lateral' | 'none' =
          email == null ? 'none' :
          scrapeSource === 'lateral' ? 'lateral' :
          'scrape';
        results[idx] = {
          lead,
          foundEmail: email,
          source: resolvedSource,
          tier,
          blockReason,
          redirectsTo,
        };
        if (email) {
          console.log(`    [enricher] ✓ ${email} (tier=${tier})`);
          opts.onEvent?.({
            type: 'enrich_email',
            index: itemIndex,
            total: queue.length,
            domain,
            email,
            tier: String(tier),
            leadId,
            // resolvedSource is 'scrape' | 'lateral' | 'none', but email!=null
            // means it can't be 'none' here — narrow it for the route handler.
            source: resolvedSource === 'lateral' ? 'lateral' : 'scrape',
            redirectsTo,
          });
        } else if (redirectsTo) {
          console.log(`    [enricher] ⤳ redirected to ${redirectsTo}`);
          opts.onEvent?.({ type: 'enrich_redirected', index: itemIndex, total: queue.length, domain, redirectsTo, leadId });
        } else if (blockReason && BLOCK_REASONS_THAT_ESCALATE.has(blockReason.replace(/^error:.*$/, 'bot_detected'))) {
          // A real scanner block — surface as a failed item with a reason code
          console.log(`    [enricher] ✗ blocked (${blockReason})`);
          opts.onEvent?.({ type: 'enrich_failed', index: itemIndex, total: queue.length, domain, reasonCode: blockReason, message: `Site blocked the scanner (${blockReason})`, leadId });
        } else {
          console.log(`    [enricher] ✗ no email (blockReason=${blockReason || 'none'})`);
          opts.onEvent?.({ type: 'enrich_no_email', index: itemIndex, total: queue.length, domain, reason: blockReason, leadId });
        }
      } catch (err) {
        const message = (err as Error).message.slice(0, 200);
        console.error(`    [enricher] ERROR for ${websiteUrl}:`, message);
        opts.onEvent?.({ type: 'enrich_failed', index: itemIndex, total: queue.length, domain, reasonCode: 'error', message, leadId });
      }

      done++;
      opts.onProgress?.(done, queue.length);
      // Small jitter between tasks in the same worker
      await humanDelay(400, 1200);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

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

// ─── MX fallback guesses (ordered — best cold-outreach address first) ───────

const GUESS_PREFIXES = ['info', 'contact', 'hello', 'support', 'sales'];

// ────────────────────────────────────────────────────────────────────────────

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

// ─── MX fallback ────────────────────────────────────────────────────────────

/**
 * Produce an `info@<domain>` guess unless DNS definitively says the domain
 * has no MX records. `'unknown'` (DNS timeout / refused) is NOT a definitive
 * answer — on Cloud Run outbound DNS to 8.8.8.8 is occasionally flaky, and
 * rejecting on that basis meant every enrichment returned zero emails on a
 * slow DNS day. A guess that ZeroBounce later flags as invalid is recoverable;
 * a silently-dropped guess is not.
 */
async function mxValidatedGuess(websiteUrl: string): Promise<string | null> {
  const domain = getDomain(websiteUrl);
  if (!domain) return null;
  const mx = await checkMx(domain);
  if (mx === 'no_mx') return null;  // definitive — skip
  return `${GUESS_PREFIXES[0]}@${domain}`;  // has_mx or unknown → guess
}

// ─── Per-lead enrichment ────────────────────────────────────────────────────

interface ScrapeSiteResult {
  found: string | null;
  candidates?: string[];
  blockReason?: string;
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
  if (!navOk) return { found: null, blockReason: lastReason ?? 'nav_error' };

  const homepage = await findEmailsOnPage(page);
  homepage.forEach((e) => all.add(e));

  // Early exit if we already have a top-priority email
  const topNow = [...all].filter((e) => rankEmail(e) === 0);
  if (topNow.length > 0) {
    return { found: pickBestEmail([...all])!, candidates: [...all] };
  }

  // 2. Sitemap-discovered contact URLs (real paths, not guessed)
  if (outOfTime()) {
    const best = pickBestEmail([...all]);
    return best ? { found: best, candidates: [...all] } : { found: null, blockReason: 'deadline_exceeded' };
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

  const best = pickBestEmail([...all]);
  return best ? { found: best, candidates: [...all] } : { found: null };
}

// ─── Tier escalation ────────────────────────────────────────────────────────

const BLOCK_REASONS_THAT_ESCALATE = new Set([
  'cloudflare_challenge', 'access_denied', 'bot_detected', 'empty_page',
]);

// Hard per-lead time budget. Without this a single slow site (Cloudflare
// challenge loops, 28 contact paths each timing out at 15s) could stall a
// worker for >7 minutes, blowing the Cloud Run 60-min request limit on
// larger batches.
const PER_LEAD_BUDGET_MS = 60_000;

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

async function enrichSingleLeadWithTiers(
  websiteUrl: string,
  startTier: Tier = 2,
): Promise<{ email: string | null; tier: Tier | 'mx' | 'none'; blockReason?: string }> {
  const deadline = Date.now() + PER_LEAD_BUDGET_MS;
  const availableTiers: Tier[] = [];
  for (const t of [startTier, 3, 4] as Tier[]) {
    if (t === startTier || !availableTiers.includes(t)) {
      if (t === 3 && !process.env.SCRAPER_DC_PROXY_URL) continue;
      if (t === 4 && !process.env.SCRAPER_RES_PROXY_URL) continue;
      availableTiers.push(t);
    }
  }

  // HTTP fast lane — try raw GET before paying browser-launch cost
  if (Date.now() < deadline) {
    try {
      const fastEmail = await httpFastLane(websiteUrl);
      if (fastEmail) {
        console.log(`    [enricher] ✓ fast-lane hit: ${fastEmail}`);
        return { email: fastEmail, tier: 2 };
      }
    } catch { /* best-effort — fall through to browser path */ }
  }

  let lastBlockReason: string | undefined;
  for (const tier of availableTiers) {
    if (Date.now() > deadline) { lastBlockReason = 'per_lead_deadline'; break; }
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      const bundle = await launchBrowser(TIER_CONFIGS[tier]);
      browser = bundle.browser;
      context = bundle.context;
      const page = await context.newPage();
      const result = await scrapeSite(page, websiteUrl, TIER_CONFIGS[tier].timeout, deadline);
      if (result.found) return { email: result.found, tier };
      const reason = result.blockReason ?? undefined;
      lastBlockReason = reason || lastBlockReason;
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

  // Final fallback — MX-validated guess
  const guess = await mxValidatedGuess(websiteUrl);
  if (guess) return { email: guess, tier: 'mx', blockReason: lastBlockReason };

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
  source: 'scrape' | 'mx' | 'none';
  tier: Tier | 'mx' | 'none';
  blockReason?: string;
}

/**
 * A structured per-item event emitted by the enricher. Callers (scrape-runner,
 * /api/enrich route) subscribe to translate these into SSE + scrape_failures rows.
 */
export type EnricherEvent =
  | { type: 'enrich_start'; index: number; total: number; domain: string }
  | { type: 'enrich_email'; index: number; total: number; domain: string; email: string; tier: string }
  | { type: 'enrich_no_email'; index: number; total: number; domain: string; reason?: string }
  | { type: 'enrich_failed'; index: number; total: number; domain: string; reasonCode: string; message: string };

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

      console.log(`  [enricher] [${done + 1}/${queue.length}] ${websiteUrl}`);
      opts.onEvent?.({ type: 'enrich_start', index: itemIndex, total: queue.length, domain });
      try {
        const { email, tier, blockReason } = await enrichSingleLeadWithTiers(websiteUrl);
        results[idx] = {
          lead,
          foundEmail: email,
          source: tier === 'mx' ? 'mx' : tier === 'none' ? 'none' : 'scrape',
          tier,
          blockReason,
        };
        if (email) {
          console.log(`    [enricher] ✓ ${email} (tier=${tier})`);
          opts.onEvent?.({ type: 'enrich_email', index: itemIndex, total: queue.length, domain, email, tier: String(tier) });
        } else if (blockReason && BLOCK_REASONS_THAT_ESCALATE.has(blockReason.replace(/^error:.*$/, 'bot_detected'))) {
          // A real scanner block — surface as a failed item with a reason code
          console.log(`    [enricher] ✗ blocked (${blockReason})`);
          opts.onEvent?.({ type: 'enrich_failed', index: itemIndex, total: queue.length, domain, reasonCode: blockReason, message: `Site blocked the scanner (${blockReason})` });
        } else {
          console.log(`    [enricher] ✗ no email (blockReason=${blockReason || 'none'})`);
          opts.onEvent?.({ type: 'enrich_no_email', index: itemIndex, total: queue.length, domain, reason: blockReason });
        }
      } catch (err) {
        const message = (err as Error).message.slice(0, 200);
        console.error(`    [enricher] ERROR for ${websiteUrl}:`, message);
        opts.onEvent?.({ type: 'enrich_failed', index: itemIndex, total: queue.length, domain, reasonCode: 'error', message });
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

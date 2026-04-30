// Stage 1 — Syntax & policy filter.
//
// Runs entirely on the candidate string. No network. The single most common
// reason scraped emails are bogus is that they came from a minified script
// blob or an obvious do-not-reply alias — both rejected here.

const EMAIL_RE_STRICT = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

const UNDELIVERABLE_PREFIXES = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
  'postmaster', 'mailer-daemon', 'bounce', 'bounces', 'abuse',
  'spam', 'unsubscribe', 'webmaster',
]);

// File extensions the scraper sometimes mistakes for TLDs.
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

export interface SyntaxResult {
  ok: boolean;
  reason?: string;
}

export function checkSyntax(email: string): SyntaxResult {
  const e = (email || '').trim().toLowerCase();
  if (!e) return { ok: false, reason: 'Empty address' };
  if (!EMAIL_RE_STRICT.test(e)) return { ok: false, reason: 'Malformed (regex)' };

  const [local, domain] = e.split('@');

  if (UNDELIVERABLE_PREFIXES.has(local)) {
    return { ok: false, reason: `Role-based prefix "${local}" is non-deliverable` };
  }

  if (local.length < 2) return { ok: false, reason: 'Local-part too short' };

  const tld = domain.split('.').pop() || '';
  if (INVALID_TLDS.has(tld)) {
    return { ok: false, reason: `TLD ".${tld}" is a file extension — likely scraped from JS/CSS` };
  }

  // Domain body (sans TLD) — real company domains are 3+ chars
  const lastDot = domain.lastIndexOf('.');
  const domainBody = domain.slice(0, lastDot);
  if (domainBody.length < 3) return { ok: false, reason: 'Domain body too short' };

  return { ok: true };
}

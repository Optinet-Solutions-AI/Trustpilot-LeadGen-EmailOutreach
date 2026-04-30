// URL sanitizer + validator for Trustpilot lead links.
// Mirrors tools/db/url_validator.py so manual edits made through the API
// produce the same canonical URL + link_status that the Python ingestion
// pipeline would.

export type LinkStatus = 'VALID' | 'FLAGGED_DEAD' | 'FLAGGED_REMOVED' | 'UNKNOWN';

const SOFT_404_MARKERS = [
  'this profile has been removed',
  'this page does not exist',
  'page not found',
  'we could not find',
  "we couldn't find",
  "sorry, we couldn",
  "couldn't find the page",
];

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const DUPLICATE_SCHEME = /^(https?:[/\\]+){2,}/i;
const SCHEME_PRESENT = /^https?:\/\//i;
const REPEATED_SLASHES = /(?<!:)\/{2,}/g;
const QUOTE_CHARS = /^["'“”‘’]+|["'“”‘’]+$/g;

export function sanitizeTrustpilotUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim().replace(QUOTE_CHARS, '').replace(/\\/g, '/');
  s = s.replace(/\s+/g, '');
  if (!s) return null;
  s = s.replace(DUPLICATE_SCHEME, 'https://');
  if (!SCHEME_PRESENT.test(s)) s = 'https://' + s.replace(/^\/+/, '');

  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  const path = (parsed.pathname || '/').replace(REPEATED_SLASHES, '/');
  const cleaned = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}`;
  return cleaned.replace(/\/+$/, '') || null;
}

export async function validateTrustpilotUrl(
  url: string,
  timeoutMs = 10_000,
): Promise<{ status: LinkStatus; error: string | null }> {
  if (!url) return { status: 'UNKNOWN', error: 'empty_url' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: DEFAULT_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return { status: 'UNKNOWN', error: `request_failed: ${name}` };
  } finally {
    clearTimeout(timer);
  }

  const status = resp.status;
  if (status === 404 || status === 410) return { status: 'FLAGGED_DEAD', error: `http_${status}` };
  if (status >= 500) return { status: 'UNKNOWN', error: `http_${status}` };
  if (status >= 400) return { status: 'FLAGGED_DEAD', error: `http_${status}` };

  const body = (await resp.text()).toLowerCase();
  for (const marker of SOFT_404_MARKERS) {
    if (body.includes(marker)) return { status: 'FLAGGED_REMOVED', error: `soft_404: ${marker}` };
  }
  return { status: 'VALID', error: null };
}

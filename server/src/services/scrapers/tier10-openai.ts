/**
 * Tier 10 — ask a model to find the address the whole ladder could not.
 *
 * WHY THIS IS LAST, AND WHY IT EXISTS AT ALL
 *
 * Every tier before this fetches a page and reads what is on it. This one
 * searches instead, which makes it the only tier that can help when the site
 * is unreachable, gone, or never published an address in scrapeable form.
 *
 * Measured 2026-09-25 on leads that had NO email after the full ladder:
 *
 *     trustpilot   2/4    info@sscinc.com, info@mbankuae.com
 *     yelp         2/4    service@hoffmanrefrigerationac.com
 *     tripadvisor  2/2    info@therevolutionhotel.com
 *     TOTAL        6/10   60%, $0.079 per email found
 *
 * That is against a ladder which is, in practice, mostly dead: the
 * ScrapingBee account is a free tier 100x over its allowance, SCRAPFLY_API_KEY
 * is unset, and Hunter's free tier is 50 calls a month. So this is not
 * competing with working tiers — for most leads it is the only one left.
 *
 * IT SEARCHES, SO IT CAN BE WRONG IN A WAY THE OTHERS CANNOT
 *
 * The earlier tiers read an address off the business's own page. This one can
 * return a plausible address for the WRONG business, or a personal mailbox
 * (`t0ny_1961@live.com` came back for a locksmith in the measured sample).
 * Two defences:
 *
 *   - `normaliseDiscoveredEmails` rejects corruption and placeholders. One in
 *     eight model addresses arrived with a Unicode hyphen that looks identical
 *     to ASCII and does not deliver.
 *   - Nothing written here is sendable until ZeroBounce has verified it. The
 *     send gate blocks `invalid` and never-verified addresses at four layers.
 *
 * COST
 *
 * ~$0.047 a lead attempted, ~$0.079 per email actually found. Enabled per-run
 * rather than always-on, because 8,314 leads at $0.047 is ~$390 and that is a
 * decision, not a default.
 *
 * ENV
 *     OPENAI_API_KEY             required
 *     ENRICH_OPENAI_ENABLED      must be 'true'; off by default
 *     ENRICH_OPENAI_MODEL        default gpt-4.1
 *     ENRICH_OPENAI_MAX_PER_RUN  hard ceiling on calls per enrichment run
 */

import { normaliseDiscoveredEmails } from './llm-email-normalise.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-4.1';
const TIMEOUT_MS = 120_000;

/** gpt-4.1 per-token rates plus the flat hosted web_search fee. */
const USD_IN = 2.0 / 1e6;
const USD_OUT = 8.0 / 1e6;
const USD_SEARCH_CALL = 0.01;

export interface Tier10Input {
  companyName?: string | null;
  websiteUrl?: string | null;
  country?: string | null;
}

export interface Tier10Result {
  email: string | null;
  /** What the call cost, so the run can report and cap its own spend. */
  usd: number;
  /** The model's own confidence, kept for triage — never used as a gate. */
  confidence?: string;
  error?: string;
}

export function openaiEnrichEnabled(): boolean {
  return (
    (process.env.ENRICH_OPENAI_ENABLED ?? '').trim().toLowerCase() === 'true'
    && Boolean((process.env.OPENAI_API_KEY ?? '').trim())
  );
}

/** Per-run ceiling on calls. 0 or unset means no ceiling. */
export function maxCallsPerRun(): number {
  const n = Number(process.env.ENRICH_OPENAI_MAX_PER_RUN ?? '0');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const SCHEMA =
  'Reply ONLY with JSON: {"email":<string|null>,"confidence":"high"|"medium"|"low"}. '
  + 'The email must be one you actually saw published for THIS business. '
  + 'If you did not see one, return null. Never construct an address from the '
  + 'company name, never return a placeholder such as info@example.com, and '
  + 'never return an address belonging to a different company.';

/**
 * A business with no usable identity cannot be searched for safely — a bare
 * domain with no name invites an address for whoever else uses that word.
 */
function buildPrompt(lead: Tier10Input): string | null {
  const name = (lead.companyName ?? '').trim();
  const site = (lead.websiteUrl ?? '').trim();
  if (!name && !site) return null;

  const lines = ['Find the public contact email address for this business.'];
  if (name) lines.push(`Name: ${name}`);
  if (site) lines.push(`Website: ${site}`);
  if (lead.country) lines.push(`Country: ${lead.country}`);
  lines.push(SCHEMA);
  return lines.join('\n');
}

function callCostUsd(usage: Record<string, number> | undefined): number {
  const u = usage ?? {};
  return (u.input_tokens ?? 0) * USD_IN + (u.output_tokens ?? 0) * USD_OUT + USD_SEARCH_CALL;
}

/** The first JSON object in the model's reply — it wraps it in prose often. */
function extractJson(text: string): Record<string, unknown> | null {
  const m = /\{[\s\S]*\}/.exec(text ?? '');
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function tier10OpenAiLookup(lead: Tier10Input): Promise<Tier10Result> {
  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) return { email: null, usd: 0, error: 'missing_key' };

  const prompt = buildPrompt(lead);
  if (!prompt) return { email: null, usd: 0, error: 'no_identity' };

  const model = (process.env.ENRICH_OPENAI_MODEL ?? DEFAULT_MODEL).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, tools: [{ type: 'web_search' }], input: prompt }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      // A failed call is not billed for tokens, but say so rather than
      // reporting a silent zero.
      return { email: null, usd: 0, error: `http_${res.status}:${detail}` };
    }

    const data = (await res.json()) as {
      usage?: Record<string, number>;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const usd = callCostUsd(data.usage);

    const text = (data.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text ?? '')
      .join('');

    const parsed = extractJson(text);
    // Normalised, never taken raw: one in eight model addresses arrived with
    // a Unicode hyphen that is visually identical to ASCII and undeliverable.
    const [email] = normaliseDiscoveredEmails(
      typeof parsed?.email === 'string' ? parsed.email : null,
    );

    return {
      email: email ?? null,
      usd,
      confidence: typeof parsed?.confidence === 'string' ? parsed.confidence : undefined,
    };
  } catch (err) {
    const e = err as Error;
    return {
      email: null,
      usd: 0,
      error: e.name === 'AbortError' ? 'timeout' : `${e.name}:${e.message.slice(0, 120)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

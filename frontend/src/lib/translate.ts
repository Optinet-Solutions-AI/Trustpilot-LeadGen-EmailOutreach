/**
 * Gemini-powered translation for inbox replies that arrive in a foreign language.
 * Uses the same NEXT_PUBLIC_GEMINI_API_KEY as the campaign template generator.
 *
 * We translate the PLAIN-TEXT of the message, not its raw HTML. Outreach emails
 * embed a screenshot/score-card image and rich markup; asking the model to
 * "preserve every HTML tag" made it reproduce the entire payload (a ~40KB
 * embedded image took >90s and timed out). Stripping to readable text first
 * keeps the prompt and the response tiny, so a translation returns in ~1-2s.
 * The result is escaped and line-broken back into light HTML for display.
 */

import { GoogleGenAI } from '@google/genai';

const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY as string;

/** Abort a stuck translation rather than spin forever on a slow/hung call. */
const TRANSLATE_TIMEOUT_MS = 30_000;
/** Cap the text we send — readable email text is short; this bounds worst case. */
const MAX_INPUT_CHARS = 16_000;
/**
 * Models tried in order. `flash-lite` is cheapest and snappy but is the first
 * to return 503 UNAVAILABLE ("high demand") under load; `flash` (what the rest
 * of the app uses) is more reliably available, so it's the fallback. We exhaust
 * retries on a model before stepping to the next.
 */
const MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'] as const;
/** Per-model retry attempts on transient (503/429/overloaded) failures. */
const MAX_ATTEMPTS_PER_MODEL = 3;

/** True for transient Gemini conditions worth retrying (overload / rate limit). */
function isTransient(err: unknown): boolean {
  const s = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    s.includes('503') ||
    s.includes('429') ||
    s.includes('unavailable') ||
    s.includes('overloaded') ||
    s.includes('high demand') ||
    s.includes('resource_exhausted')
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TranslationResult {
  /** Translated text as light HTML (escaped text + <br>), safe to render. */
  text: string;
  /** Two-letter ISO 639-1 code Gemini reported as the source. May be 'unknown'. */
  sourceLanguage: string;
}

// ── Cache ────────────────────────────────────────────────────────────────
// The same reply gets re-translated every time the user re-opens a thread or
// re-clicks "Translate", and each call is a full Gemini round-trip. Cache the
// result keyed by (target language + content) so repeats are instant.
const memCache = new Map<string, TranslationResult>();

/** djb2 — cheap, stable string hash so keys stay short regardless of body size. */
function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function cacheKey(input: string, target: string): string {
  return `tp_tr:${target}:${hashKey(input)}`;
}

function readCache(key: string): TranslationResult | null {
  const hit = memCache.get(key);
  if (hit) return hit;
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as TranslationResult;
        memCache.set(key, parsed);
        return parsed;
      }
    } catch {
      /* localStorage unavailable / quota / parse error — treat as miss */
    }
  }
  return null;
}

function writeCache(key: string, value: TranslationResult): void {
  memCache.set(key, value);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota exceeded — in-memory cache still serves this session */
    }
  }
}

// ── HTML → readable text ───────────────────────────────────────────────────
const NAMED_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return _; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; }
    })
    .replace(/&[a-z]+\d*;/gi, (m) => NAMED_ENTITIES[m.toLowerCase()] ?? m);
}

/** Strip HTML to readable plain text, keeping paragraph/line structure. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Translate a message body into the target language. `input` may be HTML or
 * plain text; we reduce it to readable text before translating. Returns light
 * HTML (escaped text + <br>) suitable for dangerouslySetInnerHTML.
 */
export async function translateText(
  input: string,
  targetLanguage = 'English',
): Promise<TranslationResult> {
  if (!API_KEY) {
    throw new Error('NEXT_PUBLIC_GEMINI_API_KEY is not set. Add it to your .env file.');
  }
  if (!input.trim()) {
    return { text: input, sourceLanguage: 'unknown' };
  }

  const key = cacheKey(input, targetLanguage);
  const cached = readCache(key);
  if (cached) return cached;

  let text = htmlToText(input);
  if (!text) return { text: '', sourceLanguage: 'unknown' };
  if (text.length > MAX_INPUT_CHARS) text = text.slice(0, MAX_INPUT_CHARS);

  const genAI = new GoogleGenAI({ apiKey: API_KEY });

  const prompt = `
Translate the email message below into ${targetLanguage}.

Rules:
- Translate only the human-readable text.
- Do not translate URLs, email addresses, file names, or proper names.
- Do not add commentary, prefaces, signatures, or notes.
- Preserve line breaks between paragraphs.
- If the message is already in ${targetLanguage}, return it unchanged.

Return your response in this EXACT format (no other text before or after):
SOURCE_LANG: [two-letter ISO 639-1 code you detected, e.g. "pt", "de", "es", or "unknown"]
TRANSLATED:
[the translated text here]

=== INPUT ===
${text}
=== END INPUT ===
`.trim();

  // Try each model in turn, retrying transient (503/429/overloaded) failures
  // with exponential backoff before stepping to the next model. flash-lite is
  // the first to get throttled under load, so this rides out a "high demand"
  // 503 instead of surfacing the raw error JSON on the first attempt.
  // thinkingBudget: 0 keeps flash-lite snappy; a timeout guards each call so a
  // hung request surfaces an error instead of an endless spinner.
  let result: Awaited<ReturnType<typeof genAI.models.generateContent>> | null = null;
  let lastErr: unknown = null;
  outer: for (const model of MODELS) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        result = await Promise.race([
          genAI.models.generateContent({
            model,
            contents: prompt,
            config: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Translation timed out — please try again.')), TRANSLATE_TIMEOUT_MS),
          ),
        ]);
        break outer;
      } catch (err) {
        lastErr = err;
        if (!isTransient(err)) throw err;        // hard error — don't waste retries
        // Backoff: 0.8s, 1.6s, 3.2s. Skip the wait on the last attempt of the
        // last model so we fail fast into the fallback message.
        const isLastTry = model === MODELS[MODELS.length - 1] && attempt === MAX_ATTEMPTS_PER_MODEL - 1;
        if (!isLastTry) await sleep(800 * 2 ** attempt);
      }
    }
  }
  if (!result) {
    throw new Error(
      'Translation service is temporarily overloaded. Please try again in a moment.' +
        (lastErr instanceof Error ? ` (${lastErr.message})` : ''),
    );
  }

  const raw = (result.text ?? '').trim();
  const sourceMatch = raw.match(/^SOURCE_LANG:\s*(\S+)/m);
  const transTag = 'TRANSLATED:';
  const transIdx = raw.indexOf(transTag);
  const translated = transIdx >= 0
    ? raw.slice(transIdx + transTag.length).replace(/^\s*\n?/, '').trimEnd()
    : raw;

  // Escape, then turn newlines into <br> so the existing HTML renderer shows
  // paragraph breaks without trusting any markup the model might emit.
  const html = escapeHtml(translated).replace(/\n/g, '<br>');

  const out: TranslationResult = {
    text: html,
    sourceLanguage: sourceMatch ? sourceMatch[1].toLowerCase().trim() : 'unknown',
  };
  writeCache(key, out);
  return out;
}

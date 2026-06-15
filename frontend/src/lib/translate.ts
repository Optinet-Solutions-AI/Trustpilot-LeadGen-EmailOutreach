/**
 * Gemini-powered translation for inbox replies that arrive in a foreign language.
 * Uses the same NEXT_PUBLIC_GEMINI_API_KEY as the campaign template generator.
 *
 * Lightweight: one round-trip per call, HTML-preserving, deterministic temperature.
 */

import { GoogleGenAI } from '@google/genai';

const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY as string;

/** Abort a stuck translation rather than spin forever on a slow/hung call. */
const TRANSLATE_TIMEOUT_MS = 20_000;

export interface TranslationResult {
  /** The translated text (or HTML if the input was HTML). */
  text: string;
  /** Two-letter ISO 639-1 code Gemini reported as the source. May be 'unknown'. */
  sourceLanguage: string;
}

// ── Cache ────────────────────────────────────────────────────────────────
// The same reply gets re-translated every time the user re-opens a thread or
// re-clicks "Translate", and each call is a full Gemini round-trip. Cache the
// result keyed by (target language + content) so repeats are instant. An
// in-memory Map covers the active session; localStorage survives navigation
// and refresh. Both are best-effort — a miss just re-fetches.
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

/**
 * Translate text or HTML into the target language.
 *
 * - When the input contains HTML tags, those are preserved verbatim; only
 *   text nodes are translated.
 * - The model is asked to wrap the output in a `<<<TRANSLATED>>>` /
 *   `<<<END>>>` envelope so we can strip any preface it may include.
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

  // Serve from cache when we've translated this exact content before.
  const key = cacheKey(input, targetLanguage);
  const cached = readCache(key);
  if (cached) return cached;

  const genAI = new GoogleGenAI({ apiKey: API_KEY });

  const prompt = `
You are translating email body content for an outreach inbox. Translate the
material below into ${targetLanguage}.

Rules:
- Preserve every HTML tag (<p>, <br>, <a>, <strong>, etc.) exactly as-is.
- Translate only the human-readable text nodes between tags.
- Do not translate URLs, email addresses, file names, or proper names.
- Do not add commentary, prefaces, signatures, or notes.
- If the input is already in ${targetLanguage}, return it unchanged.

Return your response in this EXACT format (no other text before or after):
SOURCE_LANG: [two-letter ISO 639-1 code you detected, e.g. "sv", "de", "es", or "unknown"]
TRANSLATED:
[the translated content here]

=== INPUT ===
${input}
=== END INPUT ===
`.trim();

  // thinkingBudget: 0 disables the 2.5 "thinking" pass — it's on by default and
  // is the dominant source of latency. Translation is a deterministic
  // transform that gains nothing from reasoning tokens, so turning it off is
  // the single biggest speed win here. Race against a timeout so a hung call
  // surfaces as an error instead of an endless spinner.
  const result = await Promise.race([
    genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Translation timed out — please try again.')), TRANSLATE_TIMEOUT_MS),
    ),
  ]);

  const raw = (result.text ?? '').trim();
  const sourceMatch = raw.match(/^SOURCE_LANG:\s*(\S+)/m);
  // Use indexOf split rather than a multiline regex — `m` mode `$` anchors at
  // the first newline, which truncated multi-paragraph translations to just
  // the first line. Everything after "TRANSLATED:" is the body.
  const transTag = 'TRANSLATED:';
  const transIdx = raw.indexOf(transTag);
  const translated = transIdx >= 0
    ? raw.slice(transIdx + transTag.length).replace(/^\s*\n?/, '').trimEnd()
    : raw;

  const out: TranslationResult = {
    text: translated,
    sourceLanguage: sourceMatch ? sourceMatch[1].toLowerCase().trim() : 'unknown',
  };
  writeCache(key, out);
  return out;
}

/**
 * Gemini-powered translation for inbox replies that arrive in a foreign language.
 * Uses the same NEXT_PUBLIC_GEMINI_API_KEY as the campaign template generator.
 *
 * Lightweight: one round-trip per call, HTML-preserving, deterministic temperature.
 */

import { GoogleGenAI } from '@google/genai';

const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY as string;

export interface TranslationResult {
  /** The translated text (or HTML if the input was HTML). */
  text: string;
  /** Two-letter ISO 639-1 code Gemini reported as the source. May be 'unknown'. */
  sourceLanguage: string;
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

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { temperature: 0.2 },
  });

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

  return {
    text: translated,
    sourceLanguage: sourceMatch ? sourceMatch[1].toLowerCase().trim() : 'unknown',
  };
}

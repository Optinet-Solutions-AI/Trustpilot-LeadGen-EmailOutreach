/**
 * Country -> outreach language, and the reverse lookup the lead filters use.
 *
 * WHY THIS LIVES SERVER-SIDE
 * The wizard needs "give me every lead I can email in Italian", which spans
 * IT plus the Italian-speaking part of CH. Expanding a language into country
 * codes is business logic, so it belongs here rather than in the picker —
 * the frontend just asks for a language by name.
 *
 * RELATIONSHIP TO scheduleConfig.COUNTRY_LANGUAGE
 * The frontend already carries a COUNTRY_LANGUAGE map, but it exists to pick
 * a TRANSLATION target, so it deliberately omits the English-speaking
 * countries — nothing to translate. That makes it unusable as a filter: US,
 * GB, CA and AU alone are ~8.5k leads, i.e. the largest language group by
 * far. This map adds them, and otherwise keeps the same country -> language
 * choices so a campaign filtered to "German" gets the same copy treatment
 * the translator would apply.
 *
 * MULTILINGUAL COUNTRIES are mapped to the single language most business
 * correspondence uses (CH -> German, BE -> French), matching the existing
 * translation map. A lead in French-speaking Geneva therefore lands under
 * German; that is a known simplification, not an oversight — country is the
 * only signal the leads table carries, so per-lead language would need a
 * separate detection pass.
 */

export const COUNTRY_LANGUAGE: Record<string, string> = {
  // ── English ──
  US: 'English',
  GB: 'English',
  CA: 'English',
  AU: 'English',
  IE: 'English',
  NZ: 'English',
  ZA: 'English',
  SG: 'English',
  MT: 'English',
  IN: 'English',
  PH: 'English',
  // ── Western & Central Europe ──
  AT: 'German',
  BE: 'French',
  CH: 'German',
  DE: 'German',
  ES: 'Spanish',
  FR: 'French',
  IT: 'Italian',
  LU: 'French',
  NL: 'Dutch',
  PT: 'European Portuguese',
  // ── Nordics ──
  DK: 'Danish',
  FI: 'Finnish',
  IS: 'Icelandic',
  NO: 'Norwegian',
  SE: 'Swedish',
  // ── Eastern Europe ──
  BG: 'Bulgarian',
  CZ: 'Czech',
  EE: 'Estonian',
  CY: 'Greek',
  GR: 'Greek',
  HR: 'Croatian',
  HU: 'Hungarian',
  LT: 'Lithuanian',
  LV: 'Latvian',
  PL: 'Polish',
  RO: 'Romanian',
  RS: 'Serbian',
  RU: 'Russian',
  SI: 'Slovenian',
  SK: 'Slovak',
  UA: 'Ukrainian',
  // ── Middle East ──
  AE: 'Arabic',
  BH: 'Arabic',
  EG: 'Arabic',
  IL: 'Hebrew',
  JO: 'Arabic',
  KW: 'Arabic',
  OM: 'Arabic',
  QA: 'Arabic',
  SA: 'Arabic',
  TR: 'Turkish',
  // ── Latin America ──
  AR: 'Spanish',
  BO: 'Spanish',
  BR: 'Brazilian Portuguese',
  CL: 'Spanish',
  CO: 'Spanish',
  EC: 'Spanish',
  MX: 'Spanish',
  PE: 'Spanish',
  PY: 'Spanish',
  UY: 'Spanish',
  // ── Asia ──
  CN: 'Simplified Chinese',
  ID: 'Indonesian',
  JP: 'Japanese',
  KR: 'Korean',
  MY: 'Malay',
  TH: 'Thai',
  TW: 'Traditional Chinese',
  VN: 'Vietnamese',
  // ── South Asia ──
  BD: 'Bengali',
  PK: 'Urdu',
};

/** language -> every country code that speaks it. Built once at import. */
const LANGUAGE_COUNTRIES: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [code, lang] of Object.entries(COUNTRY_LANGUAGE)) {
    (out[lang] ||= []).push(code);
  }
  return out;
})();

/**
 * Country codes for a language name, case-insensitively.
 *
 * Returns [] for an unknown language so callers can fail CLOSED — filtering
 * to "Klingon" must return no leads, never every lead.
 */
export function countriesForLanguage(language: string): string[] {
  const needle = (language || '').trim().toLowerCase();
  if (!needle) return [];
  for (const [lang, codes] of Object.entries(LANGUAGE_COUNTRIES)) {
    if (lang.toLowerCase() === needle) return codes;
  }
  return [];
}

/** The language a country writes to, or null when unmapped. */
export function languageForCountry(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_LANGUAGE[country.trim().toUpperCase()] ?? null;
}

/** Every language known to the map, alphabetical. */
export function allLanguages(): string[] {
  return Object.keys(LANGUAGE_COUNTRIES).sort();
}

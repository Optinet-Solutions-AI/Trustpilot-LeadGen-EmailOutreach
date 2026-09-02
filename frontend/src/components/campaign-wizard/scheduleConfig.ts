export const COUNTRIES = [
  { code: '', name: 'All Countries' },
  { code: 'AU', name: 'Australia' }, { code: 'AT', name: 'Austria' },
  { code: 'BR', name: 'Brazil' }, { code: 'CA', name: 'Canada' },
  { code: 'DK', name: 'Denmark' }, { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' }, { code: 'DE', name: 'Germany' },
  { code: 'IT', name: 'Italy' }, { code: 'NL', name: 'Netherlands' },
  { code: 'NO', name: 'Norway' }, { code: 'ES', name: 'Spain' },
  { code: 'SE', name: 'Sweden' }, { code: 'AE', name: 'United Arab Emirates' },
  { code: 'GB', name: 'United Kingdom' }, { code: 'US', name: 'United States' },
];

export const CATEGORIES = [
  { slug: '', name: 'All Categories' },
  { slug: 'gambling', name: 'Gambling (all)' },
  { slug: 'casino', name: 'Casino' },
  { slug: 'online_casino_or_bookmaker', name: 'Online Casino / Bookmaker' },
  { slug: 'online_sports_betting', name: 'Online Sports Betting' },
  { slug: 'betting_agency', name: 'Betting Agency' },
  { slug: 'bookmaker', name: 'Bookmaker' },
  { slug: 'gambling_service', name: 'Gambling Service' },
  { slug: 'gambling_house', name: 'Gambling House' },
  { slug: 'off_track_betting_shop', name: 'Off-Track Betting Shop' },
  { slug: 'lottery_vendor', name: 'Lottery Vendor' },
  { slug: 'online_lottery_ticket_vendor', name: 'Online Lottery Vendor' },
  { slug: 'lottery_retailer', name: 'Lottery Retailer' },
  { slug: 'lottery_shop', name: 'Lottery Shop' },
  { slug: 'gambling_instructor', name: 'Gambling Instructor' },
  { slug: 'gaming', name: 'Gaming (all)' },
  { slug: 'gaming_service_provider', name: 'Gaming Service Provider' },
  { slug: 'bingo_hall', name: 'Bingo Hall' },
  { slug: 'video_game_store', name: 'Video Game Store' },
  { slug: 'game_store', name: 'Game Store' },
  { slug: 'bank', name: 'Bank' },
  { slug: 'insurance_agency', name: 'Insurance Agency' },
  { slug: 'money_transfer_service', name: 'Money Transfer' },
  { slug: 'electronics_technology', name: 'Electronics & Technology' },
  { slug: 'travel_vacation', name: 'Travel & Vacation' },
];

// Standard IANA timezones supported by the schedule engine
export const TIMEZONES = [
  { value: 'America/New_York',      label: 'US Eastern — New York, Miami (EST/EDT)' },
  { value: 'America/Chicago',       label: 'US Central — Chicago, Dallas (CST/CDT)' },
  { value: 'America/Denver',        label: 'US Mountain — Denver, Phoenix (MST/MDT)' },
  { value: 'America/Los_Angeles',   label: 'US Pacific — Los Angeles, Seattle (PST/PDT)' },
  { value: 'America/Anchorage',     label: 'US Alaska (AKST/AKDT)' },
  { value: 'America/Bogota',        label: 'Colombia / Lima (UTC-5, no DST)' },
  { value: 'America/Sao_Paulo',     label: 'Brazil / Buenos Aires (UTC-3)' },
  { value: 'Europe/London',         label: 'UK / Ireland — London, Dublin (GMT/BST)' },
  { value: 'Europe/Paris',          label: 'Central Europe — Paris, Berlin, Amsterdam (CET/CEST)' },
  { value: 'Europe/Athens',         label: 'Eastern Europe — Athens, Kyiv (EET/EEST)' },
  { value: 'Africa/Cairo',          label: 'Egypt / South Africa — Cairo (UTC+2/+3)' },
  { value: 'Asia/Dubai',            label: 'Gulf — Dubai, Abu Dhabi (UTC+4)' },
  { value: 'Asia/Kolkata',          label: 'India (IST, UTC+5:30)' },
  { value: 'Asia/Singapore',        label: 'Singapore / Malaysia (UTC+8)' },
  { value: 'Asia/Manila',           label: 'Philippines — Manila (UTC+8)' },
  { value: 'Asia/Hong_Kong',        label: 'Hong Kong / China (UTC+8)' },
  { value: 'Asia/Tokyo',            label: 'Japan / Korea (JST, UTC+9)' },
  { value: 'Australia/Sydney',      label: 'Sydney / Melbourne (AEST/AEDT)' },
  { value: 'Pacific/Auckland',      label: 'New Zealand (NZST/NZDT)' },
  { value: 'UTC',                   label: 'UTC — Universal Coordinated Time' },
];

// Full 24-hour list. Use '23:59' for end-of-day if you want a true 24h window.
export const HOURS = [
  '00:00','01:00','02:00','03:00','04:00','05:00',
  '06:00','07:00','08:00','09:00','10:00','11:00',
  '12:00','13:00','14:00','15:00','16:00','17:00',
  '18:00','19:00','20:00','21:00','22:00','23:00',
  '23:59',
];

export const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// Auto-pick a sensible timezone when the user picks a country in Step 1.
// Values MUST exist in TIMEZONES above so the dropdown stays consistent.
// Covers every ISO 3166-1 alpha-2 code Trustpilot ships in, so adding a new
// entry to COUNTRIES doesn't require touching this file. Anything missing
// falls back to UTC via getCountryTimezone() below.
export const COUNTRY_TIMEZONE: Record<string, string> = {
  // North America
  US: 'America/New_York',
  CA: 'America/New_York',
  MX: 'America/Chicago',
  // Latin America (UTC-5 cluster)
  CO: 'America/Bogota',
  PE: 'America/Bogota',
  EC: 'America/Bogota',
  PA: 'America/Bogota',
  CL: 'America/Bogota',
  // Latin America (UTC-3 cluster)
  BR: 'America/Sao_Paulo',
  AR: 'America/Sao_Paulo',
  UY: 'America/Sao_Paulo',
  PY: 'America/Sao_Paulo',
  BO: 'America/Sao_Paulo',
  // UK / Ireland / Iberia-west
  GB: 'Europe/London',
  IE: 'Europe/London',
  PT: 'Europe/London',
  IS: 'Europe/London',
  // Central Europe (CET)
  AT: 'Europe/Paris',
  BE: 'Europe/Paris',
  CH: 'Europe/Paris',
  CZ: 'Europe/Paris',
  DE: 'Europe/Paris',
  DK: 'Europe/Paris',
  ES: 'Europe/Paris',
  FR: 'Europe/Paris',
  HR: 'Europe/Paris',
  HU: 'Europe/Paris',
  IT: 'Europe/Paris',
  LU: 'Europe/Paris',
  NL: 'Europe/Paris',
  NO: 'Europe/Paris',
  PL: 'Europe/Paris',
  RS: 'Europe/Paris',
  SE: 'Europe/Paris',
  SI: 'Europe/Paris',
  SK: 'Europe/Paris',
  // Eastern Europe (EET)
  BG: 'Europe/Athens',
  CY: 'Europe/Athens',
  EE: 'Europe/Athens',
  FI: 'Europe/Athens',
  GR: 'Europe/Athens',
  LT: 'Europe/Athens',
  LV: 'Europe/Athens',
  RO: 'Europe/Athens',
  UA: 'Europe/Athens',
  // Africa (UTC+2/+3)
  EG: 'Africa/Cairo',
  ZA: 'Africa/Cairo',
  KE: 'Africa/Cairo',
  NG: 'Africa/Cairo',
  // Gulf
  AE: 'Asia/Dubai',
  SA: 'Asia/Dubai',
  QA: 'Asia/Dubai',
  KW: 'Asia/Dubai',
  BH: 'Asia/Dubai',
  OM: 'Asia/Dubai',
  JO: 'Asia/Dubai',
  IL: 'Asia/Dubai',
  TR: 'Asia/Dubai',
  // South Asia
  IN: 'Asia/Kolkata',
  PK: 'Asia/Kolkata',
  BD: 'Asia/Kolkata',
  LK: 'Asia/Kolkata',
  // SE Asia
  SG: 'Asia/Singapore',
  MY: 'Asia/Singapore',
  ID: 'Asia/Singapore',
  TH: 'Asia/Singapore',
  VN: 'Asia/Singapore',
  PH: 'Asia/Manila',
  // East Asia
  HK: 'Asia/Hong_Kong',
  CN: 'Asia/Hong_Kong',
  TW: 'Asia/Hong_Kong',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Tokyo',
  // Oceania
  AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland',
};

/**
 * Resolve a country code to a timezone in the TIMEZONES dropdown.
 * Falls back to UTC for unmapped codes so the wizard still auto-shifts
 * when a brand-new country is added to COUNTRIES.
 */
export function getCountryTimezone(code: string): string {
  if (!code) return 'UTC';
  return COUNTRY_TIMEZONE[code.toUpperCase()] ?? 'UTC';
}

// Auto-pick the AI generation language for non-English-speaking countries.
// English-default markets (US, GB, AU, CA, NZ, IE, IN, MY, SG, PH, HK, ZA,
// KE, NG) are intentionally omitted so they fall through to the English
// prompt. For multilingual countries (CH, BE, LU) we pick the language most
// common for B2B outreach — switch by hand in the wizard if the lead skews
// the other way.
export const COUNTRY_LANGUAGE: Record<string, string> = {
  // Western & Central Europe
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
  // Nordics
  DK: 'Danish',
  FI: 'Finnish',
  IS: 'Icelandic',
  NO: 'Norwegian',
  SE: 'Swedish',
  // Eastern Europe
  BG: 'Bulgarian',
  CZ: 'Czech',
  EE: 'Estonian',
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
  // Middle East & Arabic-speaking
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
  // Latin America
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
  // Asia
  CN: 'Simplified Chinese',
  ID: 'Indonesian',
  JP: 'Japanese',
  KR: 'Korean',
  TH: 'Thai',
  TW: 'Traditional Chinese',
  VN: 'Vietnamese',
  // South Asia
  BD: 'Bengali',
  PK: 'Urdu',
};

export interface SendingSchedule {
  timezone: string;
  startHour: string;
  endHour: string;
  days: number[];
  dailyLimit: number;
  /** IDs of email accounts to rotate through for this campaign ('__env__' = primary env account, DB uuid = specific account) */
  senderAccountIds?: string[];
  /** @deprecated use senderAccountIds instead — kept for backward compat with saved campaigns */
  senderAccountId?: string;
}

export const DEFAULT_SCHEDULE: SendingSchedule = {
  timezone: 'Asia/Manila',
  startHour: '09:00',
  endHour: '17:00',
  days: [1, 2, 3, 4, 5],
  dailyLimit: 50,
};

/**
 * The single answer to "what language does this campaign write in?".
 *
 * An explicitly chosen language always wins — that is the point of the
 * language filter: a German campaign spanning AT + CH + DE has no single
 * country, so the country map can't answer for it. Otherwise fall back to the
 * country's default language, and finally to undefined, which callers read as
 * "write in English" (gemini.ts omits the language directive entirely).
 *
 * Every AI-generation call site must go through this. Reading
 * COUNTRY_LANGUAGE[filterCountry] directly is what produced English copy for
 * a Swedish audience when the country arrived empty (reported 2026-09-02).
 */
export function resolveOutreachLanguage(
  country?: string,
  language?: string,
): string | undefined {
  const explicit = language?.trim();
  if (explicit) return explicit;
  const code = country?.trim().toUpperCase();
  return code ? COUNTRY_LANGUAGE[code] : undefined;
}

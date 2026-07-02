/**
 * Locale service — resolves a per-lead locale from the lead's country and
 * localises rendered email copy for Commonwealth-English markets (AU/NZ).
 *
 * Deliberately conservative: only whole-word, case-preserving, idempotent
 * transforms, and never touches URLs, emails, or HTML tags. Any market not
 * listed resolves to the `us` variant, which is a pure no-op — existing
 * (US and every other) campaign output is unchanged.
 */

export interface LocaleInfo {
  variant: 'commonwealth' | 'us';
  currencyCode: string;
  currencySymbol: string;
  signoff: string;
}

const LOCALES: Record<string, LocaleInfo> = {
  AU: { variant: 'commonwealth', currencyCode: 'AUD', currencySymbol: 'A$', signoff: 'Cheers' },
  NZ: { variant: 'commonwealth', currencyCode: 'NZD', currencySymbol: 'NZ$', signoff: 'Cheers' },
};

const US_LOCALE: LocaleInfo = {
  variant: 'us', currencyCode: 'USD', currencySymbol: '$', signoff: 'Best regards',
};

export function resolveLocale(country?: string): LocaleInfo {
  if (!country) return US_LOCALE;
  return LOCALES[country.trim().toUpperCase()] ?? US_LOCALE;
}

// Curated US -> Commonwealth word map (base + inflected forms are listed
// explicitly to stay idempotent and avoid unsafe blanket regex rules such
// as a naive -ize rule that would wrongly hit size/prize/seize).
const WORD_MAP: Record<string, string> = {
  // -our family (explicit allowlist only)
  color: 'colour', colors: 'colours', colored: 'coloured', coloring: 'colouring',
  favor: 'favour', favors: 'favours', favored: 'favoured', favoring: 'favouring',
  favorite: 'favourite', favorites: 'favourites',
  honor: 'honour', honors: 'honours', honored: 'honoured',
  labor: 'labour', neighbor: 'neighbour', neighbors: 'neighbours',
  behavior: 'behaviour', behaviors: 'behaviours',
  flavor: 'flavour', flavors: 'flavours', humor: 'humour',
  // -re family
  center: 'centre', centers: 'centres', centered: 'centred',
  // -ise / -isation family (curated business-email verbs)
  organize: 'organise', organizes: 'organises', organized: 'organised', organizing: 'organising',
  organization: 'organisation', organizations: 'organisations',
  optimize: 'optimise', optimizes: 'optimises', optimized: 'optimised', optimizing: 'optimising',
  optimization: 'optimisation',
  realize: 'realise', realizes: 'realises', realized: 'realised', realizing: 'realising',
  recognize: 'recognise', recognizes: 'recognises', recognized: 'recognised', recognizing: 'recognising',
  apologize: 'apologise', apologized: 'apologised',
  prioritize: 'prioritise', prioritized: 'prioritised', prioritizing: 'prioritising',
  customize: 'customise', customized: 'customised', customizing: 'customising',
  personalize: 'personalise', personalized: 'personalised', personalizing: 'personalising',
  maximize: 'maximise', maximized: 'maximised', maximizing: 'maximising',
  minimize: 'minimise', minimized: 'minimised', minimizing: 'minimising',
  emphasize: 'emphasise', emphasized: 'emphasised',
  summarize: 'summarise', summarized: 'summarised',
  specialize: 'specialise', specialized: 'specialised', specializing: 'specialising',
  standardize: 'standardise', standardized: 'standardised',
  utilize: 'utilise', utilized: 'utilised', utilizing: 'utilising',
  capitalize: 'capitalise', capitalized: 'capitalised',
  analyze: 'analyse', analyzes: 'analyses', analyzed: 'analysed', analyzing: 'analysing',
  // other common irregulars
  catalog: 'catalogue', catalogs: 'catalogues',
  defense: 'defence', offense: 'offence', license: 'licence',
  traveler: 'traveller', travelers: 'travellers', traveling: 'travelling', traveled: 'travelled',
  fulfill: 'fulfil', fulfillment: 'fulfilment',
  enrollment: 'enrolment', canceled: 'cancelled', canceling: 'cancelling',
  // conservative lexical/tone swaps
  math: 'maths',
};

// Multi-word phrase swaps applied before the single-word pass.
const PHRASE_MAP: Array<[RegExp, string]> = [
  [/\bcell phones\b/gi, 'mobiles'],
  [/\bcell phone\b/gi, 'mobile'],
  [/\bzip codes\b/gi, 'postcodes'],
  [/\bzip code\b/gi, 'postcode'],
];

function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// Mask URLs, emails, and HTML tags so their internals are never rewritten.
const MASK_PATTERNS = [
  /<[^>]+>/g,                        // HTML tags
  /https?:\/\/[^\s"'<>]+/gi,         // http(s) URLs
  /\bwww\.[^\s"'<>]+/gi,             // bare www URLs
  /[\w.+-]+@[\w-]+\.[\w.-]+/gi,      // emails
];

export function localizeText(text: string, country?: string): string {
  if (resolveLocale(country).variant !== 'commonwealth') return text;

  // Mask protected spans.
  const masks: string[] = [];
  let masked = text;
  for (const re of MASK_PATTERNS) {
    masked = masked.replace(re, (m) => {
      const token = ` ${masks.length} `;
      masks.push(m);
      return token;
    });
  }

  // Phrase swaps first.
  for (const [re, rep] of PHRASE_MAP) {
    masked = masked.replace(re, (m) => matchCase(m, rep));
  }

  // Whole-word single-token swaps.
  masked = masked.replace(/[A-Za-z]+/g, (word) => {
    const rep = WORD_MAP[word.toLowerCase()];
    return rep ? matchCase(word, rep) : word;
  });

  // Restore masked spans.
  return masked.replace(/ (\d+) /g, (_, i) => masks[Number(i)]);
}

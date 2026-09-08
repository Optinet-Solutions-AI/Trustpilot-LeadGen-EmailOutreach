/**
 * One country list for every dropdown in the app.
 *
 * There were five: three hardcoded 9-entry copies (Lead Matrix, Prospects,
 * the wizard's scheduleConfig) that had drifted from the data, and the
 * wizard's Step 1 which built options straight from distinct DB codes with
 * `name: code` — which is why the same filter read "Australia" in one place
 * and "AU" in another, and why the Lead Matrix could not offer a country the
 * scraper had since started returning.
 *
 * The rule now: options come from the DATA (so a new country appears the day
 * it has leads), and the LABEL comes from here, as "Australia (AU)" — the
 * name to read, the code to match what the table column shows. Sorted by
 * name, with "All Countries" pinned first.
 */

/** ISO 3166-1 alpha-2 -> display name, for every code the data has produced. */
export const COUNTRY_NAMES: Record<string, string> = {
  AE: 'United Arab Emirates',
  AR: 'Argentina',
  AT: 'Austria',
  AU: 'Australia',
  BE: 'Belgium',
  BG: 'Bulgaria',
  BR: 'Brazil',
  CA: 'Canada',
  CH: 'Switzerland',
  CL: 'Chile',
  CO: 'Colombia',
  CR: 'Costa Rica',
  CW: 'Curaçao',
  CY: 'Cyprus',
  CZ: 'Czechia',
  DE: 'Germany',
  DK: 'Denmark',
  EE: 'Estonia',
  ES: 'Spain',
  FI: 'Finland',
  FR: 'France',
  GB: 'United Kingdom',
  GI: 'Gibraltar',
  GR: 'Greece',
  HR: 'Croatia',
  HU: 'Hungary',
  IE: 'Ireland',
  IM: 'Isle of Man',
  IN: 'India',
  IS: 'Iceland',
  IT: 'Italy',
  JP: 'Japan',
  LT: 'Lithuania',
  LU: 'Luxembourg',
  LV: 'Latvia',
  MC: 'Monaco',
  MT: 'Malta',
  MX: 'Mexico',
  MY: 'Malaysia',
  NL: 'Netherlands',
  NO: 'Norway',
  NZ: 'New Zealand',
  PE: 'Peru',
  PH: 'Philippines',
  PL: 'Poland',
  PT: 'Portugal',
  RO: 'Romania',
  RS: 'Serbia',
  SE: 'Sweden',
  SG: 'Singapore',
  SI: 'Slovenia',
  SK: 'Slovakia',
  TR: 'Türkiye',
  UA: 'Ukraine',
  US: 'United States',
  ZA: 'South Africa',
};

export interface CountryOption {
  code: string;
  /** "Australia (AU)" — or the bare code when we have no name for it. */
  label: string;
}

/** The label for one code. An unknown code shows as itself, never blank. */
export function countryLabel(code: string): string {
  if (!code) return 'All Countries';
  const name = COUNTRY_NAMES[code.toUpperCase()];
  return name ? `${name} (${code.toUpperCase()})` : code.toUpperCase();
}

/**
 * Build the dropdown options for a set of codes: "All Countries" first, then
 * the rest sorted by the name a person reads, not by the code. Unknown codes
 * sort by their code and still appear — hiding a country the data contains
 * would silently make its leads unreachable through the filter.
 */
export function countryOptions(codes: readonly string[]): CountryOption[] {
  const seen = new Set<string>();
  const rest: CountryOption[] = [];

  for (const raw of codes) {
    const code = (raw ?? '').trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    rest.push({ code, label: countryLabel(code) });
  }

  rest.sort((a, b) => a.label.localeCompare(b.label, 'en'));
  return [{ code: '', label: 'All Countries' }, ...rest];
}

/** Every country we have a name for — the fallback when no data list loaded. */
export function allCountryOptions(): CountryOption[] {
  return countryOptions(Object.keys(COUNTRY_NAMES));
}

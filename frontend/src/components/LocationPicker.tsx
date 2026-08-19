'use client';

import { useMemo } from 'react';
import Combobox, { type ComboboxOption } from '../ui/Combobox';

const NON_ENGLISH_LANGUAGES: Record<string, string> = {
  DE: 'German',   FR: 'French',     IT: 'Italian',  ES: 'Spanish',
  NL: 'Dutch',    BE: 'Dutch',      PT: 'Portuguese', BR: 'Portuguese',
  MX: 'Spanish',  JP: 'Japanese',   KR: 'Korean',   RU: 'Russian',
  CN: 'Chinese',  SE: 'Swedish',    NO: 'Norwegian',DK: 'Danish',
  FI: 'Finnish',  PL: 'Polish',     CZ: 'Czech',    GR: 'Greek',
  TR: 'Turkish',  AT: 'German',     CH: 'German',   HU: 'Hungarian',
};

interface CityEntry { city: string; country: string; language?: string }

// Full Europe + US city → ISO-country map. Mirrors CITY_TO_COUNTRY in
// tools/scraper/platforms/facebook.py — keep these two lists in sync
// when adding cities so the operator pick maps cleanly onto the
// country-mismatch group filter. Facebook itself has no location
// allowlist; this list is purely UX scaffolding. Add more cities by
// dropping a {city, country} row here AND in the Python map.
// Raw curated list — country drives the language tag via the map above.
// Keep this in sync with tools/scraper/platforms/facebook.py CITY_TO_COUNTRY.
const _RAW_CITIES: Array<{ city: string; country: string }> = [
  // ─── United Kingdom ───────────────────────────────────────────
  { city: 'London',       country: 'GB' },
  { city: 'Manchester',   country: 'GB' },
  { city: 'Birmingham',   country: 'GB' },
  { city: 'Leeds',        country: 'GB' },
  { city: 'Liverpool',    country: 'GB' },
  { city: 'Bristol',      country: 'GB' },
  { city: 'Edinburgh',    country: 'GB' },
  { city: 'Glasgow',      country: 'GB' },
  { city: 'Belfast',      country: 'GB' },
  { city: 'Cardiff',      country: 'GB' },
  // ─── Ireland ──────────────────────────────────────────────────
  { city: 'Dublin',       country: 'IE' },
  { city: 'Cork',         country: 'IE' },
  { city: 'Galway',       country: 'IE' },
  // ─── Germany ──────────────────────────────────────────────────
  { city: 'Berlin',       country: 'DE' },
  { city: 'Munich',       country: 'DE' },
  { city: 'Hamburg',      country: 'DE' },
  { city: 'Frankfurt',    country: 'DE' },
  { city: 'Cologne',      country: 'DE' },
  { city: 'Stuttgart',    country: 'DE' },
  { city: 'Düsseldorf',   country: 'DE' },
  { city: 'Leipzig',      country: 'DE' },
  // ─── France ───────────────────────────────────────────────────
  { city: 'Paris',        country: 'FR' },
  { city: 'Marseille',    country: 'FR' },
  { city: 'Lyon',         country: 'FR' },
  { city: 'Toulouse',     country: 'FR' },
  { city: 'Nice',         country: 'FR' },
  { city: 'Bordeaux',     country: 'FR' },
  { city: 'Nantes',       country: 'FR' },
  // ─── Spain ────────────────────────────────────────────────────
  { city: 'Madrid',       country: 'ES' },
  { city: 'Barcelona',    country: 'ES' },
  { city: 'Valencia',     country: 'ES' },
  { city: 'Seville',      country: 'ES' },
  { city: 'Bilbao',       country: 'ES' },
  { city: 'Málaga',       country: 'ES' },
  // ─── Italy ────────────────────────────────────────────────────
  { city: 'Rome',         country: 'IT' },
  { city: 'Milan',        country: 'IT' },
  { city: 'Naples',       country: 'IT' },
  { city: 'Florence',     country: 'IT' },
  { city: 'Turin',        country: 'IT' },
  { city: 'Bologna',      country: 'IT' },
  { city: 'Venice',       country: 'IT' },
  // ─── Netherlands ──────────────────────────────────────────────
  { city: 'Amsterdam',    country: 'NL' },
  { city: 'Rotterdam',    country: 'NL' },
  { city: 'The Hague',    country: 'NL' },
  { city: 'Utrecht',      country: 'NL' },
  { city: 'Eindhoven',    country: 'NL' },
  // ─── Belgium ──────────────────────────────────────────────────
  { city: 'Brussels',     country: 'BE' },
  { city: 'Antwerp',      country: 'BE' },
  { city: 'Ghent',        country: 'BE' },
  // ─── Portugal ─────────────────────────────────────────────────
  { city: 'Lisbon',       country: 'PT' },
  { city: 'Porto',        country: 'PT' },
  { city: 'Braga',        country: 'PT' },
  // ─── Switzerland ──────────────────────────────────────────────
  { city: 'Zurich',       country: 'CH' },
  { city: 'Geneva',       country: 'CH' },
  { city: 'Basel',        country: 'CH' },
  { city: 'Bern',         country: 'CH' },
  // ─── Austria ──────────────────────────────────────────────────
  { city: 'Vienna',       country: 'AT' },
  { city: 'Salzburg',     country: 'AT' },
  { city: 'Graz',         country: 'AT' },
  // ─── Czech Republic ───────────────────────────────────────────
  { city: 'Prague',       country: 'CZ' },
  { city: 'Brno',         country: 'CZ' },
  // ─── Poland ───────────────────────────────────────────────────
  { city: 'Warsaw',       country: 'PL' },
  { city: 'Krakow',       country: 'PL' },
  { city: 'Wrocław',      country: 'PL' },
  { city: 'Gdańsk',       country: 'PL' },
  // ─── Sweden ───────────────────────────────────────────────────
  { city: 'Stockholm',    country: 'SE' },
  { city: 'Gothenburg',   country: 'SE' },
  { city: 'Malmö',        country: 'SE' },
  // ─── Denmark ──────────────────────────────────────────────────
  { city: 'Copenhagen',   country: 'DK' },
  { city: 'Aarhus',       country: 'DK' },
  // ─── Norway ───────────────────────────────────────────────────
  { city: 'Oslo',         country: 'NO' },
  { city: 'Bergen',       country: 'NO' },
  // ─── Finland ──────────────────────────────────────────────────
  { city: 'Helsinki',     country: 'FI' },
  { city: 'Tampere',      country: 'FI' },
  // ─── Greece ───────────────────────────────────────────────────
  { city: 'Athens',       country: 'GR' },
  { city: 'Thessaloniki', country: 'GR' },
  // ─── Luxembourg ───────────────────────────────────────────────
  { city: 'Luxembourg City', country: 'LU' },
  // ─── Iceland ──────────────────────────────────────────────────
  { city: 'Reykjavik',    country: 'IS' },
  // ─── Hungary ──────────────────────────────────────────────────
  { city: 'Budapest',     country: 'HU' },
  // ─── Romania ──────────────────────────────────────────────────
  { city: 'Bucharest',    country: 'RO' },
  { city: 'Cluj-Napoca',  country: 'RO' },
  // ─── Bulgaria ─────────────────────────────────────────────────
  { city: 'Sofia',        country: 'BG' },
  { city: 'Plovdiv',      country: 'BG' },
  // ─── Croatia ──────────────────────────────────────────────────
  { city: 'Zagreb',       country: 'HR' },
  { city: 'Split',        country: 'HR' },
  // ─── Slovenia ─────────────────────────────────────────────────
  { city: 'Ljubljana',    country: 'SI' },
  // ─── Slovakia ─────────────────────────────────────────────────
  { city: 'Bratislava',   country: 'SK' },
  // ─── Baltics ──────────────────────────────────────────────────
  { city: 'Vilnius',      country: 'LT' },
  { city: 'Riga',         country: 'LV' },
  { city: 'Tallinn',      country: 'EE' },
  // ─── Mediterranean ────────────────────────────────────────────
  { city: 'Valletta',     country: 'MT' },
  { city: 'Nicosia',      country: 'CY' },
  { city: 'Limassol',     country: 'CY' },
  // ─── Western Balkans ──────────────────────────────────────────
  { city: 'Belgrade',     country: 'RS' },
  { city: 'Sarajevo',     country: 'BA' },
  { city: 'Tirana',       country: 'AL' },
  { city: 'Skopje',       country: 'MK' },
  { city: 'Podgorica',    country: 'ME' },
  // ─── Moldova ──────────────────────────────────────────────────
  { city: 'Chișinău',     country: 'MD' },
  // ─── Ukraine ──────────────────────────────────────────────────
  { city: 'Kyiv',         country: 'UA' },
  { city: 'Lviv',         country: 'UA' },
  // ─── Türkiye ──────────────────────────────────────────────────
  { city: 'Istanbul',     country: 'TR' },
  { city: 'Ankara',       country: 'TR' },
  { city: 'Izmir',        country: 'TR' },
  // ─── United States ────────────────────────────────────────────
  { city: 'New York',     country: 'US' },
  { city: 'Brooklyn',     country: 'US' },
  { city: 'Manhattan',    country: 'US' },
  { city: 'Queens',       country: 'US' },
  { city: 'Bronx',        country: 'US' },
  { city: 'Los Angeles',  country: 'US' },
  { city: 'San Diego',    country: 'US' },
  { city: 'San Francisco',country: 'US' },
  { city: 'San Jose',     country: 'US' },
  { city: 'Sacramento',   country: 'US' },
  { city: 'Chicago',      country: 'US' },
  { city: 'Houston',      country: 'US' },
  { city: 'Dallas',       country: 'US' },
  { city: 'Austin',       country: 'US' },
  { city: 'San Antonio',  country: 'US' },
  { city: 'Phoenix',      country: 'US' },
  { city: 'Las Vegas',    country: 'US' },
  { city: 'Denver',       country: 'US' },
  { city: 'Seattle',      country: 'US' },
  { city: 'Portland',     country: 'US' },
  { city: 'Philadelphia', country: 'US' },
  { city: 'Boston',       country: 'US' },
  { city: 'Washington',   country: 'US' },
  { city: 'Baltimore',    country: 'US' },
  { city: 'Atlanta',      country: 'US' },
  { city: 'Miami',        country: 'US' },
  { city: 'Orlando',      country: 'US' },
  { city: 'Tampa',        country: 'US' },
  { city: 'Charlotte',    country: 'US' },
  { city: 'Nashville',    country: 'US' },
  { city: 'Detroit',      country: 'US' },
  { city: 'Minneapolis',  country: 'US' },
  { city: 'Columbus',     country: 'US' },
  { city: 'Indianapolis', country: 'US' },
  { city: 'Cleveland',    country: 'US' },
  { city: 'Pittsburgh',   country: 'US' },
];

const LOCATION_CITIES: CityEntry[] = _RAW_CITIES.map((c) => ({
  ...c,
  language: NON_ENGLISH_LANGUAGES[c.country],
}));

/** Returns the non-English language a city primarily uses, or undefined. */
export function findCityLanguage(city: string): string | undefined {
  return LOCATION_CITIES.find((c) => c.city === city)?.language;
}

function flagEmoji(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '';
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  const [a, b] = code.toUpperCase().split('').map((c) => c.charCodeAt(0) - base + A);
  return String.fromCodePoint(a, b);
}

interface Props {
  value: string;
  onChange: (city: string) => void;
  disabled?: boolean;
  id?: string;
  /**
   * When true, the operator can type a city that isn't in the curated list
   * and commit it with Enter (passed straight to Combobox). Off by default so
   * the Facebook form stays selection-only; Instagram opts in because IG
   * hashtag search is global and any city is valid.
   */
  allowCustom?: boolean;
}

export default function LocationPicker({ value, onChange, disabled, id, allowCustom }: Props) {
  const options = useMemo<ComboboxOption[]>(
    () =>
      LOCATION_CITIES.map(({ city, country }) => ({
        value: city,
        label: city,
        // Country code + flag emoji aren't directly searchable in the label,
        // so feed them into searchText. "GB" or "Germany" still finds the
        // right cities.
        searchText: `${country} ${flagEmoji(country)}`,
      })),
    [],
  );

  const selectedCountry = useMemo(
    () => LOCATION_CITIES.find((c) => c.city === value)?.country ?? '',
    [value],
  );

  const pickedLanguage = useMemo(
    () => LOCATION_CITIES.find((c) => c.city === value)?.language,
    [value],
  );

  return (
    <div className="w-full">
      <Combobox
        id={id}
        value={value}
        onChange={onChange}
        options={options}
        placeholder="Pick a city"
        searchPlaceholder={allowCustom ? 'Search or type a city…' : 'Search cities…'}
        disabled={disabled}
        allowCustom={allowCustom}
        renderValue={(opt) => (
          <span className="flex items-center gap-2 truncate">
            <span aria-hidden className="text-base leading-none">
              {selectedCountry ? flagEmoji(selectedCountry) : ''}
            </span>
            <span className="truncate">{opt?.label ?? value}</span>
          </span>
        )}
        renderOption={(opt) => {
          const country = LOCATION_CITIES.find((c) => c.city === opt.value)?.country ?? '';
          return (
            <>
              <span aria-hidden className="text-base leading-none w-5 text-center">
                {flagEmoji(country)}
              </span>
              <span className="flex-1 truncate">{opt.label}</span>
              <span className="text-[10px] font-mono uppercase text-slate-400 tracking-widest">
                {country}
              </span>
            </>
          );
        }}
      />
      {pickedLanguage && (
        <p className="mt-1 text-[11px] italic text-on-surface-variant">
          Tip: posts in {value} are usually in {pickedLanguage}. The Gemini
          filter accepts both, but native-language niches surface more leads.
        </p>
      )}
    </div>
  );
}

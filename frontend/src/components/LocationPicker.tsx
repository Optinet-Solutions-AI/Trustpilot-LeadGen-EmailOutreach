'use client';

import { useMemo } from 'react';
import Combobox, { type ComboboxOption } from '../ui/Combobox';

// Europe-focused city → ISO-country map. Mirrors CITY_TO_COUNTRY in
// tools/scraper/platforms/facebook.py — keep these two lists in sync
// when adding cities so the operator pick maps cleanly onto the
// country-mismatch group filter.
const EUROPEAN_CITIES: Array<{ city: string; country: string }> = [
  { city: 'London',       country: 'GB' },
  { city: 'Manchester',   country: 'GB' },
  { city: 'Birmingham',   country: 'GB' },
  { city: 'Leeds',        country: 'GB' },
  { city: 'Liverpool',    country: 'GB' },
  { city: 'Bristol',      country: 'GB' },
  { city: 'Edinburgh',    country: 'GB' },
  { city: 'Glasgow',      country: 'GB' },
  { city: 'Dublin',       country: 'IE' },
  { city: 'Cork',         country: 'IE' },
  { city: 'Berlin',       country: 'DE' },
  { city: 'Munich',       country: 'DE' },
  { city: 'Hamburg',      country: 'DE' },
  { city: 'Frankfurt',    country: 'DE' },
  { city: 'Cologne',      country: 'DE' },
  { city: 'Paris',        country: 'FR' },
  { city: 'Marseille',    country: 'FR' },
  { city: 'Lyon',         country: 'FR' },
  { city: 'Nice',         country: 'FR' },
  { city: 'Madrid',       country: 'ES' },
  { city: 'Barcelona',    country: 'ES' },
  { city: 'Valencia',     country: 'ES' },
  { city: 'Seville',      country: 'ES' },
  { city: 'Rome',         country: 'IT' },
  { city: 'Milan',        country: 'IT' },
  { city: 'Naples',       country: 'IT' },
  { city: 'Florence',     country: 'IT' },
  { city: 'Amsterdam',    country: 'NL' },
  { city: 'Rotterdam',    country: 'NL' },
  { city: 'The Hague',    country: 'NL' },
  { city: 'Brussels',     country: 'BE' },
  { city: 'Antwerp',      country: 'BE' },
  { city: 'Lisbon',       country: 'PT' },
  { city: 'Porto',        country: 'PT' },
  { city: 'Zurich',       country: 'CH' },
  { city: 'Geneva',       country: 'CH' },
  { city: 'Vienna',       country: 'AT' },
  { city: 'Prague',       country: 'CZ' },
  { city: 'Warsaw',       country: 'PL' },
  { city: 'Krakow',       country: 'PL' },
  { city: 'Stockholm',    country: 'SE' },
  { city: 'Copenhagen',   country: 'DK' },
  { city: 'Oslo',         country: 'NO' },
  { city: 'Helsinki',     country: 'FI' },
  { city: 'Athens',       country: 'GR' },
];

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
}

export default function LocationPicker({ value, onChange, disabled, id }: Props) {
  const options = useMemo<ComboboxOption[]>(
    () =>
      EUROPEAN_CITIES.map(({ city, country }) => ({
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
    () => EUROPEAN_CITIES.find((c) => c.city === value)?.country ?? '',
    [value],
  );

  return (
    <Combobox
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Pick a city"
      searchPlaceholder="Search cities…"
      disabled={disabled}
      renderValue={(opt) => (
        <span className="flex items-center gap-2 truncate">
          <span aria-hidden className="text-base leading-none">
            {selectedCountry ? flagEmoji(selectedCountry) : ''}
          </span>
          <span className="truncate">{opt?.label ?? value}</span>
        </span>
      )}
      renderOption={(opt) => {
        const country = EUROPEAN_CITIES.find((c) => c.city === opt.value)?.country ?? '';
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
  );
}

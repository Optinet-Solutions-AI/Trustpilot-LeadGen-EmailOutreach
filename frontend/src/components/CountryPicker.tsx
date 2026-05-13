'use client';

import { useMemo } from 'react';
import Combobox, { type ComboboxOption } from '../ui/Combobox';
import { useTaxonomy } from '../hooks/useTaxonomy';

function flagEmoji(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '';
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  const [a, b] = code.toUpperCase().split('').map((c) => c.charCodeAt(0) - base + A);
  return String.fromCodePoint(a, b);
}

interface Props {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  id?: string;
}

export default function CountryPicker({ value, onChange, disabled, id }: Props) {
  const { countries, loading } = useTaxonomy();

  const options = useMemo<ComboboxOption[]>(
    () =>
      countries.map((c) => ({
        value: c.code,
        label: c.name,
        searchText: c.code,
      })),
    [countries],
  );

  return (
    <Combobox
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Pick a country"
      searchPlaceholder="Search countries…"
      loading={loading && options.length === 0}
      disabled={disabled}
      renderValue={(opt) => (
        <span className="flex items-center gap-2 truncate">
          <span aria-hidden className="text-base leading-none">
            {opt ? flagEmoji(opt.value) : ''}
          </span>
          <span className="truncate">{opt?.label}</span>
        </span>
      )}
      renderOption={(opt) => (
        <>
          <span aria-hidden className="text-base leading-none w-5 text-center">
            {flagEmoji(opt.value)}
          </span>
          <span className="flex-1 truncate">{opt.label}</span>
          <span className="text-[10px] font-mono uppercase text-slate-400 tracking-widest">
            {opt.value}
          </span>
        </>
      )}
    />
  );
}

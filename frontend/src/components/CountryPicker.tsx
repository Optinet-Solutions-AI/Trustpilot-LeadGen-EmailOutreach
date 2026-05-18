'use client';

import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
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
  /** When set, fetch `/api/scrape/taxonomy?platform=X` on mount instead
   *  of using the shared TaxonomyContext (which only knows about
   *  Trustpilot). Without this, Yelp's 13-country list would be shown
   *  as Trustpilot's 80-country list. */
  platform?: string;
}

interface TaxonomyCountry { code: string; name: string }

export default function CountryPicker({ value, onChange, disabled, id, platform }: Props) {
  const ctx = useTaxonomy();
  const [override, setOverride] = useState<TaxonomyCountry[] | null>(null);
  const [overrideLoading, setOverrideLoading] = useState(false);

  useEffect(() => {
    if (!platform) {
      setOverride(null);
      return;
    }
    let cancelled = false;
    setOverrideLoading(true);
    api
      .get(`/scrape/taxonomy?platform=${encodeURIComponent(platform)}&t=${Date.now()}`)
      .then((res) => {
        if (cancelled) return;
        const list = (res.data?.data?.countries ?? []) as TaxonomyCountry[];
        setOverride(Array.isArray(list) ? list : []);
      })
      .catch(() => { if (!cancelled) setOverride([]); })
      .finally(() => { if (!cancelled) setOverrideLoading(false); });
    return () => { cancelled = true; };
  }, [platform]);

  const countries = override ?? ctx.countries;
  const loading = override === null ? ctx.loading : overrideLoading;

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

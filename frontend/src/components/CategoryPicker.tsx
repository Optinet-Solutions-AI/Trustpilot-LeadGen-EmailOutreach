'use client';

import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import Combobox, { type ComboboxOption } from '../ui/Combobox';
import { useTaxonomy } from '../hooks/useTaxonomy';

interface Props {
  value: string;
  onChange: (slug: string) => void;
  disabled?: boolean;
  id?: string;
  /** When set, fetch the per-platform taxonomy instead of using the
   *  shared TaxonomyContext (which is Trustpilot-only). */
  platform?: string;
}

interface TaxonomyCategory {
  slug: string;
  display_name: string;
  parent_slug?: string | null;
}

export default function CategoryPicker({ value, onChange, disabled, id, platform }: Props) {
  const ctx = useTaxonomy();
  const [override, setOverride] = useState<TaxonomyCategory[] | null>(null);
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
        const list = (res.data?.data?.categories ?? []) as TaxonomyCategory[];
        setOverride(Array.isArray(list) ? list : []);
      })
      .catch(() => { if (!cancelled) setOverride([]); })
      .finally(() => { if (!cancelled) setOverrideLoading(false); });
    return () => { cancelled = true; };
  }, [platform]);

  const categories = override ?? ctx.categories;
  const loading = override === null ? ctx.loading : overrideLoading;

  const options = useMemo<ComboboxOption[]>(
    () =>
      categories.map((c) => ({
        value: c.slug,
        label: c.display_name,
        searchText: c.slug.replace(/_/g, ' '),
      })),
    [categories],
  );

  return (
    <Combobox
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Pick a category"
      searchPlaceholder="Search categories…"
      loading={loading && options.length === 0}
      disabled={disabled}
      renderOption={(opt) => (
        <>
          <span className="flex-1 truncate">{opt.label}</span>
          <span className="text-[10px] font-mono text-slate-400 tracking-wider">
            {opt.value}
          </span>
        </>
      )}
    />
  );
}

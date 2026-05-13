'use client';

import { useMemo } from 'react';
import Combobox, { type ComboboxOption } from '../ui/Combobox';
import { useTaxonomy } from '../hooks/useTaxonomy';

interface Props {
  value: string;
  onChange: (slug: string) => void;
  disabled?: boolean;
  id?: string;
}

export default function CategoryPicker({ value, onChange, disabled, id }: Props) {
  const { categories, loading } = useTaxonomy();

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

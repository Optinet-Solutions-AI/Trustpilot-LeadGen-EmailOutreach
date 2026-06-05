'use client';

import { useMemo } from 'react';
import Combobox, { type ComboboxOption } from '../ui/Combobox';
import { FB_NICHES, type NicheTier } from '../data/fb-niches';

interface Props {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

// Tier → dot color. Pure CSS, no icon library. Reading these as
// visual signals: 🟢 = lots of FB-group activity, 🟡 = variable,
// 🔴 = B2B (rarely surfaces on community groups).
function tierDot(tier: NicheTier): string {
  switch (tier) {
    case 'high':   return '🟢';
    case 'medium': return '🟡';
    case 'low':    return '🔴';
  }
}

export default function NichePicker({ value, onChange, disabled, id }: Props) {
  // Convert the curated FB_NICHES into ComboboxOption shape. Group headers
  // come from entry.group; the existing Combobox primitive already renders
  // section labels grouped by `group`.
  const options = useMemo<ComboboxOption[]>(
    () =>
      FB_NICHES.map((n) => ({
        value: n.slug,
        label: n.label,
        group: n.group,
        // searchText lets the operator find by tier word too — typing
        // "trade" matches the trades group.
        searchText: `${n.group} ${n.tier}`,
      })),
    [],
  );

  return (
    <Combobox
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Pick or type a niche"
      searchPlaceholder="Search niches…"
      disabled={disabled}
      allowCustom
      renderOption={(opt) => {
        const entry = FB_NICHES.find((n) => n.slug === opt.value);
        return (
          <span className="flex items-center justify-between gap-3 w-full">
            <span className="truncate">{opt.label}</span>
            <span aria-hidden className="text-xs leading-none shrink-0">
              {entry ? tierDot(entry.tier) : ''}
            </span>
          </span>
        );
      }}
      renderValue={(opt) => {
        const entry = FB_NICHES.find((n) => n.slug === (opt?.value ?? value));
        return (
          <span className="flex items-center gap-2 truncate">
            {entry && (
              <span aria-hidden className="text-base leading-none">
                {tierDot(entry.tier)}
              </span>
            )}
            <span className="truncate">{opt?.label ?? value}</span>
          </span>
        );
      }}
    />
  );
}

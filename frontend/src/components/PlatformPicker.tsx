'use client';

import { useEffect, useMemo, useState } from 'react';
import Combobox, { type ComboboxOption } from '../ui/Combobox';
import api from '../api/client';

export interface PlatformFilterField {
  name: string;
  type: 'text' | 'number' | 'select' | 'multiselect' | 'boolean';
  label: string;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  options_source?: string;
}

export interface PlatformManifest {
  name: string;
  label: string;
  base_url: string;
  requires_proxy: boolean;
  filter_schema: PlatformFilterField[];
}

interface Props {
  value: string;
  onChange: (name: string, manifest: PlatformManifest) => void;
  disabled?: boolean;
  id?: string;
  /**
   * Called once with the full manifest list after the initial fetch
   * so the parent can hand the matching manifest to <DynamicFilterFields>
   * (or its conditional equivalent).
   */
  onManifests?: (manifests: PlatformManifest[]) => void;
}

export default function PlatformPicker({ value, onChange, disabled, id, onManifests }: Props) {
  const [manifests, setManifests] = useState<PlatformManifest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/scrape/platforms')
      .then((res) => {
        if (cancelled) return;
        const data = (res.data?.data ?? []) as PlatformManifest[];
        setManifests(data);
        onManifests?.(data);
      })
      .catch(() => {
        // Empty list collapses the picker to "no platforms" — the form
        // shows the legacy Trustpilot fields by default in that case.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // onManifests intentionally NOT in deps — parent passes a fresh function
    // each render, and we only want the effect to run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options = useMemo<ComboboxOption[]>(
    () =>
      manifests.map((m) => ({
        value: m.name,
        label: m.label,
        searchText: m.name,
      })),
    [manifests],
  );

  return (
    <Combobox
      id={id}
      value={value}
      onChange={(name) => {
        const m = manifests.find((mm) => mm.name === name);
        if (m) onChange(name, m);
      }}
      options={options}
      placeholder="Pick a platform"
      searchPlaceholder="Search platforms…"
      loading={loading && options.length === 0}
      disabled={disabled}
    />
  );
}

'use client';

import {
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export interface ComboboxOption<V extends string = string> {
  value: V;
  label: string;
  /** Optional extra text used by the filter (e.g. ISO code, aliases). */
  searchText?: string;
  /** Optional group label used to render section headers. */
  group?: string;
  /** Optional indentation level (0-based). Useful for hierarchical lists. */
  indent?: number;
  /** Mark this entry as a non-selectable header (e.g. parent category). */
  isHeader?: boolean;
}

interface Props<V extends string> {
  value: V;
  onChange: (value: V) => void;
  options: ComboboxOption<V>[];
  placeholder?: string;
  /** Custom rendering for each option in the dropdown. Defaults to label. */
  renderOption?: (option: ComboboxOption<V>, state: { active: boolean; selected: boolean }) => ReactNode;
  /** Custom rendering for the selected value shown in the closed input. */
  renderValue?: (option: ComboboxOption<V> | undefined) => ReactNode;
  /** Search input placeholder when open. */
  searchPlaceholder?: string;
  loading?: boolean;
  disabled?: boolean;
  /** Empty-list state inside the dropdown. */
  emptyState?: ReactNode;
  className?: string;
  id?: string;
}

export default function Combobox<V extends string>({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  renderOption,
  renderValue,
  searchPlaceholder = 'Search…',
  loading = false,
  disabled = false,
  emptyState,
  className = '',
  id,
}: Props<V>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => options.find((o) => o.value === value), [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    // Token-based AND-match: "casino vendor" matches "Online Casino & Bookmaker Vendor".
    // Tokens with non-word chars are normalized so "&" / "_" / "-" don't bury matches.
    const tokens = q.split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      if (o.isHeader) return false;
      const hay = `${o.label} ${o.value} ${o.searchText ?? ''} ${o.group ?? ''}`
        .toLowerCase()
        .replace(/[_\-&/]/g, ' ');
      return tokens.every((t) => hay.includes(t));
    });
  }, [options, query]);

  const selectableIndexes = useMemo(
    () => filtered.map((o, i) => (o.isHeader ? -1 : i)).filter((i) => i >= 0),
    [filtered],
  );

  // Clamp active index when filter changes
  useEffect(() => {
    if (activeIndex >= selectableIndexes.length) setActiveIndex(0);
  }, [activeIndex, selectableIndexes.length]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Focus input when opening
  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      setQuery('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commit = useCallback(
    (opt: ComboboxOption<V>) => {
      if (opt.isHeader) return;
      onChange(opt.value);
      setOpen(false);
      setQuery('');
    },
    [onChange],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, selectableIndexes.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const idx = selectableIndexes[activeIndex];
        if (idx != null && filtered[idx]) commit(filtered[idx]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        setQuery('');
      }
    },
    [activeIndex, commit, filtered, selectableIndexes],
  );

  const valueNode = selected ? (
    renderValue ? renderValue(selected) : <span>{selected.label}</span>
  ) : (
    <span className="text-slate-400">{placeholder}</span>
  );

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        id={id}
        disabled={disabled || loading}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 border border-slate-200 bg-white rounded-md px-3 py-2 text-sm text-left transition-colors hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#b0004a]/30 focus:border-[#b0004a]/40 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="min-w-0 flex-1 truncate flex items-center gap-2">
          {loading ? <span className="text-slate-400">Loading…</span> : valueNode}
        </span>
        <span className="material-symbols-outlined text-[18px] text-slate-400 shrink-0" aria-hidden>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {open && !disabled && !loading && (
        <div className="absolute z-30 mt-1 left-0 right-0 bg-white border border-slate-200 rounded-md shadow-lg overflow-hidden">
          <div className="p-2 border-b border-slate-100">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-sm focus:outline-none placeholder:text-slate-400"
            />
          </div>
          <ul
            role="listbox"
            className="max-h-72 overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-sm text-secondary text-center">
                {emptyState ?? 'No results'}
              </li>
            ) : (
              filtered.map((opt, i) => {
                if (opt.isHeader) {
                  return (
                    <li
                      key={`h-${opt.group ?? opt.value}-${i}`}
                      className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-50/50"
                    >
                      {opt.label}
                    </li>
                  );
                }
                const positionAmongSelectable = selectableIndexes.indexOf(i);
                const active = positionAmongSelectable === activeIndex;
                const isSelected = opt.value === value;
                const indent = (opt.indent ?? 0) * 12;
                return (
                  <li key={opt.value} role="option" aria-selected={isSelected}>
                    <button
                      type="button"
                      onMouseEnter={() => setActiveIndex(positionAmongSelectable)}
                      onClick={() => commit(opt)}
                      style={{ paddingLeft: 12 + indent }}
                      className={`w-full text-left text-sm py-2 pr-3 flex items-center gap-2 transition-colors ${
                        active ? 'bg-[#ffd9de]/50' : 'hover:bg-surface-container'
                      } ${isSelected ? 'font-semibold text-[#b0004a]' : 'text-on-surface'}`}
                    >
                      {renderOption ? renderOption(opt, { active, selected: isSelected }) : opt.label}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

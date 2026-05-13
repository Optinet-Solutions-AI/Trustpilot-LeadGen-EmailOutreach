'use client';

import { useCallback } from 'react';

interface Props {
  value: [number, number];
  onChange: (value: [number, number]) => void;
  min: number;
  max: number;
  step?: number;
  label?: string;
  /** Optional suffix shown after each numeric input value (e.g. "★"). */
  suffix?: string;
  disabled?: boolean;
  className?: string;
}

export default function RangeInput({
  value,
  onChange,
  min,
  max,
  step = 0.5,
  label,
  suffix,
  disabled,
  className = '',
}: Props) {
  const [lo, hi] = value;

  const setLo = useCallback(
    (raw: string) => {
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return;
      const clamped = Math.max(min, Math.min(n, hi));
      onChange([clamped, hi]);
    },
    [hi, min, onChange],
  );

  const setHi = useCallback(
    (raw: string) => {
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return;
      const clamped = Math.min(max, Math.max(n, lo));
      onChange([lo, clamped]);
    },
    [lo, max, onChange],
  );

  return (
    <div className={className}>
      {label && (
        <label className="block text-sm font-medium text-on-surface mb-1.5">
          {label}{' '}
          <span className="text-secondary font-normal">
            {lo}
            {suffix} – {hi}
            {suffix}
          </span>
        </label>
      )}
      <div className="flex gap-2 items-center">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={lo}
          disabled={disabled}
          onChange={(e) => setLo(e.target.value)}
          className="w-20 border border-slate-200 bg-white rounded-md px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b0004a]/30 focus:border-[#b0004a]/40 disabled:opacity-50"
        />
        <span className="text-slate-400 text-sm">to</span>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={hi}
          disabled={disabled}
          onChange={(e) => setHi(e.target.value)}
          className="w-20 border border-slate-200 bg-white rounded-md px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b0004a]/30 focus:border-[#b0004a]/40 disabled:opacity-50"
        />
      </div>
    </div>
  );
}

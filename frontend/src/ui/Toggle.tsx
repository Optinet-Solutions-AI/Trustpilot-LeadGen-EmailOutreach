'use client';

import { ChangeEvent, InputHTMLAttributes, forwardRef, ReactNode } from 'react';

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: ReactNode;
  description?: ReactNode;
  /** Override the default e.target.checked semantics — kept compatible for drop-in <input> swaps. */
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
}

const Toggle = forwardRef<HTMLInputElement, Props>(function Toggle(
  { label, description, checked, disabled, className = '', onChange, ...rest },
  ref,
) {
  return (
    <label
      className={`inline-flex items-start gap-3 cursor-pointer select-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`}
    >
      <span className="relative inline-flex shrink-0 items-center mt-0.5">
        <input
          ref={ref}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          className="sr-only peer"
          {...rest}
        />
        <span
          className="w-9 h-5 rounded-full bg-slate-200 peer-checked:bg-[#b0004a] transition-colors"
          aria-hidden
        />
        <span
          className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4"
          aria-hidden
        />
      </span>
      {(label || description) && (
        <span className="text-sm leading-tight">
          {label && <span className="block font-medium text-on-surface">{label}</span>}
          {description && (
            <span className="block text-xs text-secondary mt-0.5">{description}</span>
          )}
        </span>
      )}
    </label>
  );
});

export default Toggle;

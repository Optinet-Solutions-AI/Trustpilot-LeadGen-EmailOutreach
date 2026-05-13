'use client';

import { ButtonHTMLAttributes, forwardRef, ReactNode } from 'react';

type Tone = 'neutral' | 'danger' | 'brand';
type Size = 'sm' | 'md';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: ReactNode;
  /** Required for screen readers — describe the action, not the icon. */
  label: string;
  tone?: Tone;
  size?: Size;
}

const TONE: Record<Tone, string> = {
  neutral: 'text-slate-400 hover:text-slate-700',
  danger: 'text-slate-300 hover:text-[#b0004a]',
  brand: 'text-[#b0004a] hover:text-[#8a003a]',
};

const SIZE: Record<Size, string> = {
  sm: 'p-1 rounded',
  md: 'p-1.5 rounded-md',
};

const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { icon, label, tone = 'neutral', size = 'md', className = '', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${TONE[tone]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {icon}
    </button>
  );
});

export default IconButton;

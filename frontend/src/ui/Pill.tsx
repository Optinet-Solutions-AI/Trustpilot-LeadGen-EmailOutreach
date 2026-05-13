'use client';

import { ReactNode } from 'react';

type Variant = 'running' | 'success' | 'error' | 'neutral' | 'info' | 'brand';
type Size = 'sm' | 'md';

interface Props {
  variant?: Variant;
  size?: Size;
  pulse?: boolean;
  leading?: ReactNode;
  className?: string;
  children: ReactNode;
}

const VARIANT: Record<Variant, { wrap: string; dot: string }> = {
  running: { wrap: 'bg-[#ffd9de] text-[#b0004a]', dot: 'bg-[#b0004a]' },
  success: { wrap: 'bg-[#8ff9a8]/30 text-[#006630]', dot: 'bg-[#006630]' },
  error:   { wrap: 'bg-error-container text-error',  dot: 'bg-error' },
  neutral: { wrap: 'bg-surface-container text-secondary', dot: 'bg-slate-400' },
  info:    { wrap: 'bg-slate-100 text-slate-600', dot: 'bg-slate-500' },
  brand:   { wrap: 'bg-[#ffd9de] text-[#b0004a]', dot: 'bg-[#b0004a]' },
};

const SIZE: Record<Size, string> = {
  sm: 'text-[10px] px-2 py-0.5',
  md: 'text-[11px] px-2.5 py-1',
};

export default function Pill({
  variant = 'neutral',
  size = 'md',
  pulse = false,
  leading,
  className = '',
  children,
}: Props) {
  const v = VARIANT[variant];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-black uppercase tracking-wide ${v.wrap} ${SIZE[size]} ${className}`}
    >
      {pulse && (
        <span className={`w-1.5 h-1.5 rounded-full ${v.dot} animate-pulse inline-block`} />
      )}
      {leading}
      {children}
    </span>
  );
}

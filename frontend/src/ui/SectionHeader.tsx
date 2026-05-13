'use client';

import { ReactNode } from 'react';

interface Props {
  /** Plain title (use `accent` to pink-tint a trailing word) OR a full ReactNode. */
  title: ReactNode;
  /** Optional trailing word rendered in brand pink (e.g. "Dashboard"). */
  accent?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  size?: 'lg' | 'md';
  className?: string;
}

const SIZE: Record<NonNullable<Props['size']>, string> = {
  lg: 'text-2xl sm:text-4xl',
  md: 'text-xl sm:text-2xl',
};

export default function SectionHeader({
  title,
  accent,
  subtitle,
  actions,
  size = 'lg',
  className = '',
}: Props) {
  return (
    <div
      className={`flex flex-col sm:flex-row sm:justify-between sm:items-end gap-2 ${className}`}
    >
      <div>
        <h2
          className={`${SIZE[size]} font-extrabold tracking-tight text-on-surface`}
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          {title}
          {accent && <span className="text-[#b0004a]"> {accent}</span>}
        </h2>
        {subtitle && (
          <p className="text-secondary mt-1 font-medium text-sm sm:text-base">{subtitle}</p>
        )}
      </div>
      {actions && <div className="self-start sm:self-auto flex-shrink-0">{actions}</div>}
    </div>
  );
}

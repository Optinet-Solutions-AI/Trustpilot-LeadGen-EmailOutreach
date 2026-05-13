'use client';

import Spinner from './Spinner';

interface Props {
  /** When 'skeleton', renders a placeholder block instead of a spinner. */
  variant?: 'spinner' | 'skeleton';
  /** Skeleton row count (variant='skeleton' only). */
  rows?: number;
  label?: string;
  className?: string;
}

export default function LoadingState({
  variant = 'spinner',
  rows = 3,
  label = 'Loading…',
  className = '',
}: Props) {
  if (variant === 'skeleton') {
    return (
      <div className={`space-y-2 ${className}`} role="status" aria-label={label}>
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-3 rounded bg-slate-100 animate-pulse"
            style={{ width: `${80 - i * 8}%` }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 text-secondary text-sm ${className}`}
      role="status"
      aria-label={label}
    >
      <Spinner size="sm" />
      <span>{label}</span>
    </div>
  );
}

'use client';

import { ReactNode } from 'react';

type Variant = 'default' | 'compact' | 'flush';

interface Props {
  variant?: Variant;
  header?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

const PADDING: Record<Variant, string> = {
  default: 'p-4 sm:p-6 xl:p-8',
  compact: 'p-4 sm:p-6',
  flush: 'p-0',
};

export default function Card({
  variant = 'default',
  header,
  actions,
  className = '',
  children,
}: Props) {
  return (
    <div className={`bg-surface-container-lowest rounded-xl ambient-shadow ${className}`}>
      {(header || actions) && (
        <div className="px-6 py-5 sm:px-8 sm:py-6 border-b border-slate-50 flex items-center justify-between gap-4">
          {header && <div className="min-w-0 flex-1">{header}</div>}
          {actions && <div className="flex items-center gap-3 shrink-0">{actions}</div>}
        </div>
      )}
      <div className={PADDING[variant]}>{children}</div>
    </div>
  );
}

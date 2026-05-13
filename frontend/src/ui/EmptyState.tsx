'use client';

import { ReactNode } from 'react';

interface Props {
  /** Material Symbol name OR a ReactNode. */
  icon?: string | ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export default function EmptyState({ icon, title, description, action, className = '' }: Props) {
  const iconNode =
    typeof icon === 'string' ? (
      <span className="material-symbols-outlined text-[36px] text-slate-300">{icon}</span>
    ) : (
      icon
    );

  return (
    <div
      className={`flex flex-col items-center justify-center text-center py-12 px-6 ${className}`}
    >
      {iconNode && <div className="mb-3">{iconNode}</div>}
      <h4
        className="font-extrabold text-on-surface text-base"
        style={{ fontFamily: 'Manrope, sans-serif' }}
      >
        {title}
      </h4>
      {description && (
        <p className="text-sm text-secondary mt-1 max-w-md">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

'use client';

import { ReactNode } from 'react';

type Tone = 'brand' | 'success' | 'neutral';

interface Props {
  /** Material Symbol name (e.g. 'group') OR a ReactNode (e.g. <svg>). */
  icon: string | ReactNode;
  label: string;
  value: ReactNode;
  helper?: ReactNode;
  tone?: Tone;
  action?: ReactNode;
  className?: string;
}

const TONE: Record<Tone, { iconBg: string; iconFg: string }> = {
  brand:   { iconBg: 'bg-[#ffd9de]',          iconFg: 'text-[#b0004a]' },
  success: { iconBg: 'bg-[#8ff9a8]/30',       iconFg: 'text-[#006630]' },
  neutral: { iconBg: 'bg-surface-container',  iconFg: 'text-secondary' },
};

export default function Stat({
  icon,
  label,
  value,
  helper,
  tone = 'brand',
  action,
  className = '',
}: Props) {
  const t = TONE[tone];
  const iconNode =
    typeof icon === 'string' ? (
      <span className={`p-2 ${t.iconBg} ${t.iconFg} rounded-lg material-symbols-outlined text-[20px]`}>
        {icon}
      </span>
    ) : (
      <span className={`p-2 ${t.iconBg} ${t.iconFg} rounded-lg inline-flex`}>{icon}</span>
    );

  return (
    <div className={`bg-surface-container-lowest rounded-xl ambient-shadow p-6 ${className}`}>
      <div className="flex items-center justify-between mb-4">
        {iconNode}
        {action}
      </div>
      <p className="text-slate-500 text-xs font-bold uppercase tracking-wider">{label}</p>
      <h4
        className="text-2xl font-black text-on-surface mt-1"
        style={{ fontFamily: 'Manrope, sans-serif' }}
      >
        {value}
      </h4>
      {helper && <p className="text-xs text-secondary mt-1">{helper}</p>}
    </div>
  );
}

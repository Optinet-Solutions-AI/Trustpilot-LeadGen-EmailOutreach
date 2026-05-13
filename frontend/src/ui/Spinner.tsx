'use client';

interface Props {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  label?: string;
}

const SIZE: Record<NonNullable<Props['size']>, string> = {
  sm: 'w-3.5 h-3.5 border-2',
  md: 'w-4 h-4 border-2',
  lg: 'w-6 h-6 border-[3px]',
};

export default function Spinner({ size = 'md', className = '', label }: Props) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      className={`inline-block rounded-full border-current border-t-transparent animate-spin ${SIZE[size]} ${className}`}
    />
  );
}

import type { LeadStatus } from '../types/lead';

const STATUS_COLORS: Record<LeadStatus, string> = {
  new:        'bg-surface-container-high text-secondary',
  contacted:  'bg-blue-50 text-blue-700',
  replied:    'bg-[#8ff9a8]/30 text-[#006630]',
  converted:  'bg-[#ffd9de] text-[#b0004a]',
  lost:       'bg-red-50 text-red-600',
};

export default function StatusBadge({ status }: { status: LeadStatus }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold capitalize ${STATUS_COLORS[status] || 'bg-surface-container-high text-secondary'}`}>
      {status}
    </span>
  );
}

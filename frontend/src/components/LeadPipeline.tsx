import StatusBadge from './StatusBadge';
import type { Lead, LeadStatus } from '../types/lead';

const COLUMNS: { key: LeadStatus; label: string; accent: string; dot: string }[] = [
  { key: 'new',       label: 'New',       accent: 'border-t-slate-400',   dot: 'bg-slate-400' },
  { key: 'contacted', label: 'Contacted', accent: 'border-t-blue-400',    dot: 'bg-blue-400' },
  { key: 'replied',   label: 'Replied',   accent: 'border-t-[#006630]',   dot: 'bg-[#006630]' },
  { key: 'converted', label: 'Converted', accent: 'border-t-[#b0004a]',   dot: 'bg-[#b0004a]' },
  { key: 'lost',      label: 'Lost',      accent: 'border-t-error',       dot: 'bg-error' },
];

interface Props {
  leads: Lead[];
  onStatusChange: (id: string, status: LeadStatus) => void;
  onLeadClick: (id: string) => void;
}

export default function LeadPipeline({ leads, onStatusChange, onLeadClick }: Props) {
  const grouped = COLUMNS.map((col) => ({
    ...col,
    leads: leads.filter((l) => l.outreach_status === col.key),
  }));

  return (
    <div className="flex gap-4 overflow-x-auto p-6">
      {grouped.map((col) => (
        <div
          key={col.key}
          className={`flex-shrink-0 w-64 bg-surface-container-low rounded-xl border-t-4 ${col.accent}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const leadId = e.dataTransfer.getData('leadId');
            if (leadId) onStatusChange(leadId, col.key);
          }}
        >
          <div className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${col.dot}`} />
              <h3 className="font-bold text-sm text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                {col.label}
              </h3>
            </div>
            <span className="text-xs font-bold bg-white ambient-shadow rounded-full px-2 py-0.5 text-secondary">
              {col.leads.length}
            </span>
          </div>
          <div className="px-3 pb-3 space-y-2 max-h-[calc(100vh-280px)] overflow-y-auto">
            {col.leads.map((lead) => (
              <div
                key={lead.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('leadId', lead.id)}
                onClick={() => onLeadClick(lead.id)}
                className="bg-surface-container-lowest rounded-xl p-3 cursor-pointer hover:ambient-shadow transition-all border border-slate-50 hover:border-slate-100"
              >
                <p className="font-bold text-sm text-on-surface truncate">{lead.company_name}</p>
                {lead.primary_email && (
                  <p className="text-xs text-secondary truncate mt-1 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[12px]">alternate_email</span>
                    {lead.primary_email}
                  </p>
                )}
                <div className="flex items-center justify-between mt-2.5">
                  {lead.star_rating !== null && (
                    <span className="text-xs font-bold text-[#b0004a]">{lead.star_rating.toFixed(1)} ★</span>
                  )}
                  <StatusBadge status={lead.outreach_status} />
                </div>
              </div>
            ))}
            {col.leads.length === 0 && (
              <div className="text-center py-6">
                <span className="material-symbols-outlined text-[24px] text-slate-200 block mb-1">inbox</span>
                <p className="text-xs text-secondary">No leads</p>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

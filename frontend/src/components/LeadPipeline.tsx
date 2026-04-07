import StatusBadge from './StatusBadge';
import type { Lead, LeadStatus } from '../types/lead';

const COLUMNS: { key: LeadStatus; label: string; color: string }[] = [
  { key: 'new', label: 'New', color: 'border-t-gray-400' },
  { key: 'contacted', label: 'Contacted', color: 'border-t-blue-400' },
  { key: 'replied', label: 'Replied', color: 'border-t-green-400' },
  { key: 'converted', label: 'Converted', color: 'border-t-purple-400' },
  { key: 'lost', label: 'Lost', color: 'border-t-red-400' },
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
    <div className="flex gap-4 overflow-x-auto pb-4">
      {grouped.map((col) => (
        <div key={col.key}
          className={`flex-shrink-0 w-64 bg-gray-50 rounded-lg border-t-4 ${col.color}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const leadId = e.dataTransfer.getData('leadId');
            if (leadId) onStatusChange(leadId, col.key);
          }}>
          <div className="p-3 flex items-center justify-between">
            <h3 className="font-medium text-sm">{col.label}</h3>
            <span className="text-xs bg-white border border-gray-200 rounded-full px-2 py-0.5">
              {col.leads.length}
            </span>
          </div>
          <div className="px-2 pb-2 space-y-2 max-h-[calc(100vh-250px)] overflow-y-auto">
            {col.leads.map((lead) => (
              <div key={lead.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('leadId', lead.id)}
                onClick={() => onLeadClick(lead.id)}
                className="bg-white rounded border border-gray-200 p-3 cursor-pointer hover:shadow-sm transition-shadow">
                <p className="font-medium text-sm truncate">{lead.company_name}</p>
                {lead.primary_email && (
                  <p className="text-xs text-gray-500 truncate mt-1">{lead.primary_email}</p>
                )}
                <div className="flex items-center justify-between mt-2">
                  {lead.star_rating !== null && (
                    <span className="text-xs text-gray-400">{lead.star_rating.toFixed(1)} stars</span>
                  )}
                  <StatusBadge status={lead.outreach_status} />
                </div>
              </div>
            ))}
            {col.leads.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-4">No leads</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

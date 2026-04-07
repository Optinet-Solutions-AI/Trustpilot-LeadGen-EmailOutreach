import { MessageSquare, ArrowRight, Mail, Phone, Clock, ShieldCheck } from 'lucide-react';
import type { LeadNote } from '../types/lead';

const TYPE_CONFIG: Record<string, { icon: typeof MessageSquare; color: string }> = {
  note: { icon: MessageSquare, color: 'text-gray-500 bg-gray-100' },
  status_change: { icon: ArrowRight, color: 'text-blue-500 bg-blue-100' },
  email_sent: { icon: Mail, color: 'text-green-500 bg-green-100' },
  email_opened: { icon: Mail, color: 'text-purple-500 bg-purple-100' },
  email_replied: { icon: Mail, color: 'text-teal-500 bg-teal-100' },
  email_bounced: { icon: Mail, color: 'text-red-500 bg-red-100' },
  call: { icon: Phone, color: 'text-orange-500 bg-orange-100' },
  follow_up: { icon: Clock, color: 'text-yellow-500 bg-yellow-100' },
  verification: { icon: ShieldCheck, color: 'text-cyan-500 bg-cyan-100' },
};

export default function ActivityTimeline({ notes }: { notes: LeadNote[] }) {
  return (
    <div className="space-y-3">
      {notes.map((note) => {
        const cfg = TYPE_CONFIG[note.type] || TYPE_CONFIG.note;
        const Icon = cfg.icon;
        return (
          <div key={note.id} className="flex gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${cfg.color}`}>
              <Icon size={14} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-700">{note.content || note.type}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                {new Date(note.created_at).toLocaleString()}
              </p>
            </div>
          </div>
        );
      })}
      {notes.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-4">No activity yet</p>
      )}
    </div>
  );
}

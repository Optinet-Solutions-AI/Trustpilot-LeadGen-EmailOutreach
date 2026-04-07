import { useState } from 'react';
import { CalendarPlus } from 'lucide-react';

interface Props {
  onSchedule: (dueDate: string, note?: string) => Promise<void>;
}

export default function FollowUpScheduler({ onSchedule }: Props) {
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!date) return;
    setSaving(true);
    await onSchedule(new Date(date).toISOString(), note || undefined);
    setDate('');
    setNote('');
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 flex-wrap">
      <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)}
        className="border border-gray-300 rounded-md px-3 py-2 text-sm" />
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Reminder note (optional)"
        className="flex-1 min-w-[150px] border border-gray-300 rounded-md px-3 py-2 text-sm" />
      <button type="submit" disabled={saving || !date}
        className="inline-flex items-center gap-1 bg-yellow-500 text-white px-3 py-2 rounded-md text-sm hover:bg-yellow-600 disabled:opacity-50">
        <CalendarPlus size={14} /> Schedule
      </button>
    </form>
  );
}

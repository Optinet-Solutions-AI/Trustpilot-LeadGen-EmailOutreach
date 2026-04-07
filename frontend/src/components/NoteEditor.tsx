import { useState } from 'react';
import { Send } from 'lucide-react';

interface Props {
  onSubmit: (content: string) => Promise<void>;
}

export default function NoteEditor({ onSubmit }: Props) {
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    setSaving(true);
    await onSubmit(content.trim());
    setContent('');
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input type="text" value={content} onChange={(e) => setContent(e.target.value)}
        placeholder="Add a note..." disabled={saving}
        className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm" />
      <button type="submit" disabled={saving || !content.trim()}
        className="bg-blue-600 text-white px-3 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50">
        <Send size={14} />
      </button>
    </form>
  );
}

import { useState, useCallback } from 'react';
import api from '../api/client';
import type { LeadNote } from '../types/lead';

export function useNotes(leadId: string) {
  const [notes, setNotes] = useState<LeadNote[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/leads/${leadId}/notes`);
      setNotes(res.data.data);
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  const addNote = useCallback(async (content: string, type = 'note') => {
    const res = await api.post(`/leads/${leadId}/notes`, { type, content });
    setNotes((prev) => [res.data.data, ...prev]);
    return res.data.data;
  }, [leadId]);

  return { notes, loading, fetchNotes, addNote };
}

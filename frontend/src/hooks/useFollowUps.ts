import { useState, useCallback } from 'react';
import api from '../api/client';
import type { FollowUp } from '../types/lead';

export function useFollowUps(leadId?: string) {
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchFollowUps = useCallback(async () => {
    setLoading(true);
    try {
      const url = leadId ? `/leads/${leadId}/follow-ups` : '/follow-ups?upcoming=true';
      const res = await api.get(url);
      setFollowUps(res.data.data);
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  const createFollowUp = useCallback(async (dueDate: string, note?: string) => {
    if (!leadId) return;
    const res = await api.post(`/leads/${leadId}/follow-ups`, { dueDate, note });
    setFollowUps((prev) => [...prev, res.data.data]);
    return res.data.data;
  }, [leadId]);

  const completeFollowUp = useCallback(async (id: string) => {
    await api.patch(`/follow-ups/${id}/complete`);
    setFollowUps((prev) => prev.map((f) => (f.id === id ? { ...f, completed: true } : f)));
  }, []);

  return { followUps, loading, fetchFollowUps, createFollowUp, completeFollowUp };
}

import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';

export interface GroupCandidate {
  id: string;
  group_id: string;
  name: string | null;
  member_count_text: string | null;
  is_private: boolean | null;
  relevance_tier: number | null;
  niche: string | null;
  location: string | null;
  status: 'candidate' | 'joined' | 'ignored';
  first_seen_at: string;
  last_seen_at: string;
  joined_detected_at: string | null;
}

export function useGroupQueue(status: 'candidate' | 'joined' | 'ignored' = 'candidate') {
  const [rows, setRows] = useState<GroupCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/social-groups/queue?status=${status}`);
      setRows(res.data.data ?? []);
      setError(null);
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } }; message?: string })
        .response?.data?.error ?? (err as Error).message ?? 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  const setStatus = useCallback(async (id: string, next: GroupCandidate['status']) => {
    await api.patch(`/social-groups/queue/${id}`, { status: next });
    await load();
  }, [load]);

  return { rows, loading, error, reload: load, setStatus };
}

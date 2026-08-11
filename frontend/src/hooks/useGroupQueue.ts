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
  const [joining, setJoining] = useState(false);

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

  // Kicks off run.py's join-groups action for the given country and
  // returns immediately (the route responds 202 without waiting for the
  // Python run to finish — it can take several minutes). Since there's
  // no push channel for progress, re-poll the queue a handful of times
  // over ~2 minutes so status flips (candidate -> joined) show up without
  // a manual refresh.
  const triggerAutoJoin = useCallback(async (country: string) => {
    setJoining(true);
    try {
      await api.post('/social-groups/join', { country });
      await load();
      const rePolls = [20_000, 40_000, 60_000, 90_000, 120_000];
      rePolls.forEach((ms) => setTimeout(() => { void load(); }, ms));
      setError(null);
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } }; message?: string })
        .response?.data?.error ?? (err as Error).message ?? 'Failed to start auto-join');
    } finally {
      setJoining(false);
    }
  }, [load]);

  return { rows, loading, error, reload: load, setStatus, triggerAutoJoin, joining };
}

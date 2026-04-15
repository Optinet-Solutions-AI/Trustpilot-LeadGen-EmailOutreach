import { useState, useCallback } from 'react';
import api from '../api/client';
import type { Affiliate } from '../components/affiliate-monitor/AffiliateData';

export function useAffiliates() {
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAffiliates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ success: boolean; data: Affiliate[] }>('/affiliates');
      setAffiliates(res.data.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load affiliates');
    } finally {
      setLoading(false);
    }
  }, []);

  const addAffiliate = useCallback(async (payload: Omit<Affiliate, 'id' | 'created_at'>): Promise<Affiliate> => {
    const res = await api.post<{ success: boolean; data: Affiliate }>('/affiliates', payload);
    const created = res.data.data;
    setAffiliates((prev) => [...prev, created]);
    return created;
  }, []);

  const bulkDelete = useCallback(async (ids: string[]): Promise<void> => {
    await api.post('/affiliates/bulk-delete', { ids });
    setAffiliates((prev) => prev.filter((a) => !ids.includes(a.id)));
  }, []);

  return { affiliates, loading, error, fetchAffiliates, addAffiliate, bulkDelete };
}

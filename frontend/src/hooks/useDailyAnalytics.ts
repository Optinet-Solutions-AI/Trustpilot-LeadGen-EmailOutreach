import { useState, useCallback, useEffect } from 'react';
import api from '../api/client';

export interface DailyAnalyticsDay {
  date: string;   // YYYY-MM-DD (UTC)
  sent: number;
  replied: number;
}

export interface DailyAnalyticsData {
  start: string;
  end: string;
  days: DailyAnalyticsDay[];
  totals: { sent: number; replied: number };
}

export function useDailyAnalytics(start: string, end: string) {
  const [data, setData] = useState<DailyAnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/analytics/daily?start=${start}&end=${end}`);
      setData(res.data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load daily analytics');
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => { fetch(); }, [fetch]);

  return { data, loading, error, refetch: fetch };
}

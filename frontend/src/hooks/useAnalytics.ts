import { useState, useCallback } from 'react';
import api from '../api/client';

export type AnalyticsPeriod = '7d' | '30d' | 'all';

export interface AnalyticsData {
  totalLeads: number;
  totalVerified: number;
  leadsByStatus: Record<string, number>;
  leadsByCountry: Record<string, number>;
  leadsByCategory: Record<string, number>;
  campaigns: Array<{
    id: string;
    name: string;
    status: string;
    total_sent: number;
    total_opened: number;
    total_replied: number;
    total_bounced: number;
  }>;
  recentScrapeJobs: Array<{
    id: string;
    country: string;
    category: string;
    status: string;
    total_found: number;
    created_at: string;
  }>;
  period: AnalyticsPeriod;
}

export function useAnalytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async (period: AnalyticsPeriod = 'all') => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/analytics?period=${period}`);
      setData(res.data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, error, fetchAnalytics };
}

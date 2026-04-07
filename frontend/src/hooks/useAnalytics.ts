import { useState, useCallback } from 'react';
import api from '../api/client';

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
}

export function useAnalytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/analytics');
      setData(res.data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, error, fetchAnalytics };
}

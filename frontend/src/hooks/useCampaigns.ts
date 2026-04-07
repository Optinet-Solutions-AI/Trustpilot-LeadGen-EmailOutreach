import { useState, useCallback } from 'react';
import api from '../api/client';
import type { Campaign } from '../types/campaign';

export function useCampaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/campaigns');
      setCampaigns(res.data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch campaigns');
    } finally {
      setLoading(false);
    }
  }, []);

  const createCampaign = useCallback(async (data: {
    name: string;
    templateSubject: string;
    templateBody: string;
    includeScreenshot?: boolean;
    leadIds?: string[];
    filterCountry?: string;
    filterCategory?: string;
  }) => {
    const res = await api.post('/campaigns', data);
    setCampaigns((prev) => [res.data.data, ...prev]);
    return res.data.data as Campaign;
  }, []);

  const sendCampaign = useCallback(async (campaignId: string, options?: { testMode?: boolean }) => {
    const res = await api.post(`/campaigns/${campaignId}/send`, { testMode: options?.testMode ?? false });
    return res.data.data as { campaignId: string; emailCount: number; testMode: boolean; message: string };
  }, []);

  const addLeads = useCallback(async (campaignId: string, leadIds: string[]) => {
    await api.post(`/campaigns/${campaignId}/leads`, { leadIds });
  }, []);

  const checkReplies = useCallback(async () => {
    const res = await api.post('/gmail/check-replies');
    return res.data.data as { repliesFound: number };
  }, []);

  const getRateLimit = useCallback(async () => {
    const res = await api.get('/gmail/rate-limit');
    return res.data.data as {
      hourlyCount: number;
      hourlyCap: number;
      hourlyRemaining: number;
      hourlyResetAt: string;
      dailyCount: number;
      dailyCap: number;
      dailyRemaining: number;
      dailyResetAt: string;
      canSend: boolean;
    };
  }, []);

  return { campaigns, loading, error, fetchCampaigns, createCampaign, sendCampaign, addLeads, checkReplies, getRateLimit };
}

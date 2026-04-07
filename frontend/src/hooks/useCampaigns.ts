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
    return res.data.data;
  }, []);

  const sendCampaign = useCallback(async (campaignId: string) => {
    const res = await api.post(`/campaigns/${campaignId}/send`);
    return res.data.data;
  }, []);

  const addLeads = useCallback(async (campaignId: string, leadIds: string[]) => {
    await api.post(`/campaigns/${campaignId}/leads`, { leadIds });
  }, []);

  return { campaigns, loading, error, fetchCampaigns, createCampaign, sendCampaign, addLeads };
}

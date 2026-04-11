import { useState, useCallback } from 'react';
import api from '../api/client';
import type { Campaign, CampaignStep as CampaignStepType } from '../types/campaign';

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
    manualEmails?: string[];
    filterCountry?: string;
    filterCategory?: string;
    followUpSteps?: Array<{ delayDays: number; subject: string; body: string }>;
    sendingSchedule?: {
      timezone: string;
      startHour: string;
      endHour: string;
      days: number[];
      dailyLimit: number;
    };
  }) => {
    const res = await api.post('/campaigns', data);
    setCampaigns((prev) => [res.data.data, ...prev]);
    return res.data.data as Campaign;
  }, []);

  const sendCampaign = useCallback(async (campaignId: string, options?: { testMode?: boolean; testEmail?: string; limit?: number }) => {
    const res = await api.post(`/campaigns/${campaignId}/send`, {
      testMode: options?.testMode ?? false,
      testEmail: options?.testEmail || undefined,
      limit: options?.limit || undefined,
    });
    return res.data.data as { campaignId: string; emailCount: number; testMode: boolean; message: string };
  }, []);

  const cancelCampaign = useCallback(async (campaignId: string) => {
    await api.post(`/campaigns/${campaignId}/cancel`);
  }, []);

  const deleteCampaign = useCallback(async (campaignId: string) => {
    await api.delete(`/campaigns/${campaignId}`);
    setCampaigns((prev) => prev.filter((c) => c.id !== campaignId));
  }, []);

  const addLeads = useCallback(async (campaignId: string, leadIds: string[]) => {
    await api.post(`/campaigns/${campaignId}/leads`, { leadIds });
  }, []);

  const getCampaignLeads = useCallback(async (campaignId: string) => {
    const res = await api.get(`/campaigns/${campaignId}/leads`);
    return res.data.data as Array<{
      id: string;
      lead_id: string;
      email_used: string | null;
      status: string;
      sent_at: string | null;
      leads: { company_name: string; star_rating: number; country: string; category: string } | null;
    }>;
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

  const testFlightSend = useCallback(async (campaignId: string, testEmail: string) => {
    const res = await api.post(`/campaigns/${campaignId}/test-flight`, { testEmail });
    return res.data.data as { sentTo: string; leadUsed: string; originalEmail: string; messageId?: string };
  }, []);

  const getWarmupStatus = useCallback(async () => {
    const res = await api.get('/campaigns/warmup-status');
    return res.data.data as { day: number; currentCap: number; phase: string; lifetimeSent: number; isWarmedUp: boolean };
  }, []);

  const duplicateCampaign = useCallback(async (campaignId: string) => {
    const res = await api.post(`/campaigns/${campaignId}/duplicate`);
    const newCampaign = res.data.data as Campaign;
    setCampaigns((prev) => [newCampaign, ...prev]);
    return newCampaign;
  }, []);

  const previewRecipients = useCallback(async (filters: { country?: string; category?: string }) => {
    const params = new URLSearchParams();
    if (filters.country) params.set('country', filters.country);
    if (filters.category) params.set('category', filters.category);
    const res = await api.get(`/campaigns/preview-recipients?${params.toString()}`);
    return res.data.data as { count: number; sample: Array<{ id: string; company_name: string; primary_email: string; star_rating: number }> };
  }, []);

  /** Trigger on-demand stats sync for platform-managed campaigns */
  const syncStats = useCallback(async (campaignId: string) => {
    const res = await api.post(`/campaigns/${campaignId}/sync`);
    // Refresh campaign list to pick up updated stats
    await fetchCampaigns();
    return res.data.data as { pending: number; sent: number; opened: number; replied: number; bounced: number };
  }, [fetchCampaigns]);

  /** Check if a third-party email platform is configured */
  const getPlatformStatus = useCallback(async () => {
    const res = await api.get('/campaigns/platform-status');
    return res.data.data as { enabled: boolean; platform: string; ok?: boolean; error?: string };
  }, []);

  /** Fetch follow-up steps for a campaign */
  const getCampaignSteps = useCallback(async (campaignId: string) => {
    const res = await api.get(`/campaigns/${campaignId}/steps`);
    return res.data.data as CampaignStepType[];
  }, []);

  return { campaigns, loading, error, fetchCampaigns, createCampaign, sendCampaign, cancelCampaign, deleteCampaign, addLeads, getCampaignLeads, checkReplies, getRateLimit, duplicateCampaign, previewRecipients, testFlightSend, syncStats, getPlatformStatus, getCampaignSteps, getWarmupStatus };
}

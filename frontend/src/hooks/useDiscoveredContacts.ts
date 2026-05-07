'use client';

import { useState, useCallback, useEffect } from 'react';
import api from '../api/client';
import type { Lead } from '../types/lead';

export type DiscoveredKind = 'email' | 'url';
export type DiscoveredStatus = 'pending_review' | 'accepted' | 'dismissed' | 'spawned_lead';
export type DiscoveredVerification = 'valid' | 'invalid' | 'catch-all' | 'unknown' | null;

export interface DiscoveredContact {
  id: string;
  lead_id: string;
  source_campaign_lead_id: string | null;
  kind: DiscoveredKind;
  value: string;
  role: string | null;
  score: number;
  verification_status: DiscoveredVerification;
  scrape_result: Record<string, unknown> | null;
  status: DiscoveredStatus;
  auto_reply_message_id: string | null;
  auto_reply_metadata: Record<string, unknown> | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export interface DiscoveredContactWithLead extends DiscoveredContact {
  lead: Lead | null;
}

interface ListFilters {
  status?: DiscoveredStatus;
  kind?: DiscoveredKind;
  limit?: number;
  offset?: number;
}

export function usePendingDiscoveries(filters: ListFilters = {}) {
  const [data, setData] = useState<DiscoveredContactWithLead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      if (filters.kind) params.set('kind', filters.kind);
      if (filters.limit) params.set('limit', String(filters.limit));
      if (filters.offset) params.set('offset', String(filters.offset));

      const res = await api.get(`/discovered-contacts?${params}`);
      setData(res.data.data?.data ?? []);
      setTotal(res.data.data?.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch discovered contacts');
    } finally {
      setLoading(false);
    }
  }, [filters.status, filters.kind, filters.limit, filters.offset]);

  // Initial fetch + 60s auto-refresh — the worker is verifying / scraping in
  // the background, so the UI needs to pick up newly-verified candidates and
  // newly-harvested URL emails without a manual reload.
  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  return { data, total, loading, error, refresh: fetchData };
}

export function useLeadDiscoveries(leadId: string | null) {
  const [data, setData] = useState<DiscoveredContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!leadId) {
      setData([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/leads/${leadId}/discovered-contacts`);
      setData(res.data.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch lead discoveries');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}

export function useDiscoveryActions() {
  const accept = useCallback(async (id: string) => {
    const res = await api.post(`/discovered-contacts/${id}/accept`);
    return res.data.data;
  }, []);

  const dismiss = useCallback(async (id: string, reason?: string) => {
    const res = await api.post(`/discovered-contacts/${id}/dismiss`, reason ? { reason } : {});
    return res.data.data;
  }, []);

  const spawnLead = useCallback(async (id: string) => {
    const res = await api.post(`/discovered-contacts/${id}/spawn-lead`);
    return res.data.data;
  }, []);

  return { accept, dismiss, spawnLead };
}

export function useDiscoveryCount() {
  const [count, setCount] = useState(0);
  const fetchCount = useCallback(async () => {
    try {
      const res = await api.get('/discovered-contacts/count');
      setCount(res.data.data?.pending ?? 0);
    } catch {
      // Sidebar badge — failures are silent
    }
  }, []);
  useEffect(() => {
    fetchCount();
    const id = setInterval(fetchCount, 60_000);
    return () => clearInterval(id);
  }, [fetchCount]);
  return count;
}

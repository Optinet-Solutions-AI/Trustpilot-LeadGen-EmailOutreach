import { useState, useCallback } from 'react';
import api from '../api/client';
import type { Lead, LeadStatus } from '../types/lead';

/**
 * Every filter this hook forwards to GET /api/leads.
 *
 * THIS IS AN ALLOWLIST, and the query builder below only sets the keys named
 * here. A caller passing anything else gets it silently dropped -- the
 * request succeeds, the response looks plausible, and the filter simply does
 * not apply. That failure mode cost us the verification, language,
 * prospect-type and blocked filters, all of which appeared to work in the UI
 * while the server never saw them (found 2026-09-02 when a "No address on
 * file" filter returned leads with addresses).
 *
 * So: when you add a filter to the Lead Matrix, add it HERE too, and never
 * reach the hook through an `as any` cast -- the cast is what hid this.
 */
interface LeadFilters {
  status?: LeadStatus;
  country?: string;
  category?: string;
  search?: string;
  // Per-platform Leads pages (migration 032). When set, the API JOINs
  // through lead_platform_presences and returns only leads with a
  // presence on the named platform.
  platform?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  hasEmail?: string;
  /** Inverse of hasEmail: only leads with no address on any source column. */
  noEmail?: string;
  /** 'valid' | 'invalid' | 'catch-all' | 'unknown' | 'unverified' (NULL verdict). */
  verificationStatus?: string;
  /** Outreach language name; expands server-side to every country that speaks it. */
  language?: string;
  /** Comma-joined prospect types (migration 063), e.g. 'operator,unclassified'. */
  prospectType?: string;
  blocked?: 'only' | 'exclude' | 'all';
  redirected?: 'only' | 'exclude' | 'all';
}

export function useLeads() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLeads = useCallback(async (filters: LeadFilters = {}) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      if (filters.country) params.set('country', filters.country);
      if (filters.category) params.set('category', filters.category);
      if (filters.search) params.set('search', filters.search);
      if (filters.platform) params.set('platform', filters.platform);
      if (filters.page) params.set('page', String(filters.page));
      if (filters.limit) params.set('limit', String(filters.limit));
      if (filters.sortBy) params.set('sortBy', filters.sortBy);
      if (filters.sortDir) params.set('sortDir', filters.sortDir);
      if (filters.hasEmail) params.set('hasEmail', filters.hasEmail);
      if (filters.noEmail) params.set('noEmail', filters.noEmail);
      if (filters.verificationStatus) params.set('verificationStatus', filters.verificationStatus);
      if (filters.language) params.set('language', filters.language);
      if (filters.prospectType) params.set('prospectType', filters.prospectType);
      if (filters.blocked && filters.blocked !== 'all') params.set('blocked', filters.blocked);
      if (filters.redirected && filters.redirected !== 'all') params.set('redirected', filters.redirected);

      const res = await api.get(`/leads?${params}`);
      setLeads(res.data.data);
      setTotal(res.data.total);
      setTotalPages(res.data.totalPages);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch leads');
    } finally {
      setLoading(false);
    }
  }, []);

  const updateLead = useCallback(async (id: string, patch: Partial<Lead>) => {
    const res = await api.patch(`/leads/${id}`, patch);
    setLeads((prev) => prev.map((l) => (l.id === id ? res.data.data : l)));
    return res.data.data;
  }, []);

  const deleteLead = useCallback(async (id: string) => {
    await api.delete(`/leads/${id}`);
    setLeads((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const bulkDelete = useCallback(async (ids: string[]) => {
    const res = await api.delete('/leads/bulk', { data: { ids } });
    const idSet = new Set(ids);
    setLeads((prev) => prev.filter((l) => !idSet.has(l.id)));
    setTotal((prev) => Math.max(0, prev - (res.data?.data?.deleted ?? ids.length)));
    return res.data?.data?.deleted ?? ids.length;
  }, []);

  const bulkUpdate = useCallback(async (ids: string[], patch: Partial<Lead>) => {
    const res = await api.patch('/leads/bulk', { ids, patch });
    return res.data.data;
  }, []);

  return { leads, total, totalPages, loading, error, fetchLeads, updateLead, deleteLead, bulkDelete, bulkUpdate };
}

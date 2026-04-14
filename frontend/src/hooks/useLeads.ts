import { useState, useCallback } from 'react';
import api from '../api/client';
import type { Lead, LeadStatus } from '../types/lead';

interface LeadFilters {
  status?: LeadStatus;
  country?: string;
  category?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  hasEmail?: string;
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
      if (filters.page) params.set('page', String(filters.page));
      if (filters.limit) params.set('limit', String(filters.limit));
      if (filters.sortBy) params.set('sortBy', filters.sortBy);
      if (filters.sortDir) params.set('sortDir', filters.sortDir);
      if (filters.hasEmail) params.set('hasEmail', filters.hasEmail);

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

  const bulkUpdate = useCallback(async (ids: string[], patch: Partial<Lead>) => {
    const res = await api.patch('/leads/bulk', { ids, patch });
    return res.data.data;
  }, []);

  return { leads, total, totalPages, loading, error, fetchLeads, updateLead, deleteLead, bulkUpdate };
}

import { useState, useCallback } from 'react';
import api from '../api/client';

export interface CommentDraft {
  id: string;
  lead_id: string;
  account_id: string | null;
  post_url: string | null;
  post_excerpt: string | null;
  draft_text: string;
  status: 'pending' | 'approved' | 'discarded' | 'posted';
  niche: string | null;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function useCommentDrafts() {
  const [drafts, setDrafts] = useState<CommentDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listDrafts = useCallback(async (leadId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/comment-drafts?lead_id=${encodeURIComponent(leadId)}`);
      setDrafts(res.data.data);
      return res.data.data as CommentDraft[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch comment drafts';
      setError(msg);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const createDraft = useCallback(async (payload: {
    lead_id: string;
    post_url: string;
    post_excerpt: string | null;
    niche: string | null;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post('/comment-drafts/draft', payload);
      const draft = res.data.data as CommentDraft;
      setDrafts((prev) => [draft, ...prev.filter((d) => d.id !== draft.id)]);
      return draft;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create comment draft';
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const updateDraft = useCallback(async (
    id: string,
    patch: { draft_text?: string; status?: 'approved' | 'discarded' },
  ) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.patch(`/comment-drafts/${id}`, patch);
      const updated = res.data.data as CommentDraft;
      setDrafts((prev) => prev.map((d) => d.id === id ? updated : d));
      return updated;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to update comment draft';
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const postDraft = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post(`/comment-drafts/${id}/post`);
      const posted = res.data.data as CommentDraft;
      setDrafts((prev) => prev.map((d) => d.id === id ? posted : d));
      return posted;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to post comment';
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { drafts, loading, error, listDrafts, createDraft, updateDraft, postDraft };
}

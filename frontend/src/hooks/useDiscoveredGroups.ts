import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';

export interface DiscoveredGroup {
  id: string;
  group_id: string;
  name: string | null;
  member_count_text: string | null;
  is_private: boolean | null;
  relevance_tier: number | null;
  niche: string | null;
  /** "<City>, <ISO2>" / bare ISO2 / bare city — set by the Gemini labeller
   *  (tools/scraper/label_fb_groups.py). Null until labelled. */
  location: string | null;
  /** Who posts here: 'customers' (valuable), 'trades' (worthless as leads),
   *  'unclear', or null when not yet labelled. */
  audience: 'customers' | 'trades' | 'unclear' | null;
  status: 'candidate' | 'joined' | 'ignored';
  first_seen_at: string;
  last_seen_at: string;
  joined_detected_at: string | null;
  /** How many lead_platform_posts rows we've captured from this group. */
  post_count: number;
  /** Most recent post's posted_at/scraped_at, or null if we've only ever
   *  seen this group via the assisted-join browser crawl, never a post. */
  last_post_seen: string | null;
}

export function useDiscoveredGroups() {
  const [rows, setRows] = useState<DiscoveredGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [labelling, setLabelling] = useState(false);
  const [labelResult, setLabelResult] = useState<{ labelled: number; total_unlabelled: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/social-groups/discovered');
      setRows(res.data.data ?? []);
      setError(null);
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } }; message?: string })
        .response?.data?.error ?? (err as Error).message ?? 'Failed to load discovered groups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const labelUnlabelled = useCallback(async () => {
    setLabelling(true);
    setLabelResult(null);
    try {
      // Batched Gemini calls (up to 40 groups/call) can comfortably exceed
      // the client's default 30s timeout once there's more than one batch
      // of backlog — override it here rather than raising the global
      // default, since every other endpoint's 30s cap is the right call for
      // catching a real stall. The Python process isn't killed by a client
      // timeout either way, so a slow response never loses the labelling.
      const res = await api.post('/social-groups/label', {}, { timeout: 120_000 });
      const data = res.data.data as { labelled: number; total_unlabelled: number };
      setLabelResult(data);
      await load();
      return data;
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } }; message?: string })
        .response?.data?.error ?? (err as Error).message ?? 'Failed to label groups');
      return null;
    } finally {
      setLabelling(false);
    }
  }, [load]);

  return { rows, loading, error, reload: load, labelUnlabelled, labelling, labelResult };
}

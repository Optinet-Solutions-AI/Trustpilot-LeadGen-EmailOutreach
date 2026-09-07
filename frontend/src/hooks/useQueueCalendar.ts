import { useState, useCallback, useEffect } from 'react';
import api from '../api/client';

export interface QueueCampaignShare {
  id: string;
  name: string;
  count: number;
}

export interface QueueDay {
  /** YYYY-MM-DD in the owning campaign's timezone, not UTC. */
  date: string;
  firstTouch: number;
  followUp: number;
  sent: number;
  scheduled: number;
  total: number;
  capacity: number | null;
  overCapacity: boolean;
  overBy: number;
  campaigns: QueueCampaignShare[];
}

export interface QueueCalendarData {
  from: string;
  to: string;
  senderCount: number;
  days: QueueDay[];
  totals: {
    firstTouch: number;
    followUp: number;
    total: number;
    daysOver: number;
  };
}

/** YYYY-MM-DD for a Date, in local terms (no UTC shift). */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function useQueueCalendar(from: string, to: string) {
  const [data, setData] = useState<QueueCalendarData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/campaigns/calendar?from=${from}&to=${to}`);
      setData(res.data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the send queue');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, reload: load };
}

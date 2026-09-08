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

// ── One day's leads, and one lead's message ──────────────────────────────────

export interface DayLead {
  id: string;
  leadId: string;
  company: string;
  email: string;
  campaignId: string;
  campaignName: string;
  timezone: string;
  kind: 'first_touch' | 'follow_up';
  state: 'sent' | 'scheduled';
  at: string;
  /** HH:mm in the campaign's timezone — the time it actually goes out. */
  localTime: string;
  stepNumber: number;
  senderEmail: string | null;
  country: string | null;
}

export interface LeadMessage {
  campaignName: string;
  company: string | null;
  to: string | null;
  country: string | null;
  senderEmail: string | null;
  status: string;
  stepNumber: number;
  isFollowUp: boolean;
  includeScreenshot: boolean;
  schedule: { at: string | null; timezone: string; localTime: string | null };
  message: { subject: string; body: string } | null;
  sequenceComplete?: boolean;
  /** Set when the template carries spintax, so this is one rendering of many. */
  spintaxWarning: string | null;
}

export function useDayLeads(date: string | null) {
  const [leads, setLeads] = useState<DayLead[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!date) { setLeads(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get(`/campaigns/calendar/day?date=${date}`)
      .then((res) => { if (!cancelled) setLeads(res.data.data.leads); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load the day'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  return { leads, loading, error };
}

export function useLeadMessage(campaignLeadId: string | null, step: number | null) {
  const [data, setData] = useState<LeadMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!campaignLeadId) { setData(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const q = step ? `?step=${step}` : '';
    api.get(`/campaigns/calendar/lead/${campaignLeadId}${q}`)
      .then((res) => { if (!cancelled) setData(res.data.data); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load the message'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [campaignLeadId, step]);

  return { data, loading, error };
}

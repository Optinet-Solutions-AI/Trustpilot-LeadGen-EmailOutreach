'use client';

import { useState, useCallback, useRef } from 'react';
import type { CampaignSendProgress } from '../types/campaign';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '';

export function useCampaignProgress() {
  const [progress, setProgress] = useState<CampaignSendProgress[]>([]);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'sending' | 'completed' | 'failed' | 'cancelled'>('idle');
  const [sent, setSent] = useState(0);
  const [failed, setFailed] = useState(0);
  const [total, setTotal] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  const subscribe = useCallback((campaignId: string) => {
    // Close any existing connection
    if (esRef.current) {
      esRef.current.close();
    }

    setProgress([]);
    setStatus('connecting');
    setSent(0);
    setFailed(0);
    setTotal(0);

    const url = `${API_BASE}/api/campaigns/${campaignId}/send/status`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as CampaignSendProgress;

        setProgress((prev) => [...prev, data]);

        if (data.stage === 'started') {
          setStatus('sending');
          setTotal(data.total ?? 0);
        } else if (data.stage === 'sent') {
          setSent(data.sent ?? 0);
          setFailed(data.failed ?? 0);
        } else if (data.stage === 'completed') {
          setStatus('completed');
          setSent(data.sent ?? 0);
          setFailed(data.failed ?? 0);
          es.close();
        } else if (data.stage === 'cancelled') {
          setStatus('cancelled');
          setSent(data.sent ?? 0);
          setFailed(data.failed ?? 0);
          es.close();
        } else if (data.stage === 'failed') {
          setStatus('failed');
          es.close();
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      // SSE connection closed by server on completion — not necessarily an error
      if (status !== 'completed' && status !== 'cancelled') {
        setStatus('failed');
      }
      es.close();
    };
  }, [status]);

  const stop = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setStatus('idle');
  }, []);

  const reset = useCallback(() => {
    stop();
    setProgress([]);
    setSent(0);
    setFailed(0);
    setTotal(0);
  }, [stop]);

  return { progress, status, sent, failed, total, subscribe, stop, reset };
}

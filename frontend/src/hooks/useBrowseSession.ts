import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/client';

export type BrowseStatus =
  | 'idle'
  | 'starting'
  | 'provisioning'
  | 'ready'
  | 'failed'
  | 'ended'
  | 'expired';

export function useBrowseSession() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<BrowseStatus>('idle');
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup interval on unmount.
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  const start = useCallback(async (
    accountId: string,
    opts: { targetUrl?: string | null; requestedBy: string },
  ): Promise<void> => {
    // Cancel any existing poll before starting a new one.
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    setLoading(true);
    setError(null);
    setStatus('starting');
    setTunnelUrl(null);

    try {
      await api.post(`/social-accounts/${accountId}/browse`, {
        targetUrl: opts.targetUrl ?? null,
        requestedBy: opts.requestedBy,
      });
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        .response?.data?.error ?? (err as Error).message ?? 'Failed';
      setError(msg);
      setStatus('failed');
      setLoading(false);
      return;
    }

    setStatus('provisioning');

    // Poll /connect-status every 2s.
    const interval = setInterval(() => {
      void (async () => {
        try {
          const res = await api.get(`/social-accounts/${accountId}/connect-status`);
          const view = res.data.data as {
            connect_status: string | null;
            connect_tunnel_url: string | null;
            connect_error: string | null;
          };

          const s = view.connect_status ?? 'provisioning';
          let nextStatus: BrowseStatus;
          if (s === 'requested' || s === 'provisioning') {
            nextStatus = 'provisioning';
          } else if (s === 'ready') {
            nextStatus = 'ready';
          } else if (s === 'failed') {
            nextStatus = 'failed';
          } else if (s === 'ended') {
            nextStatus = 'ended';
          } else if (s === 'expired') {
            nextStatus = 'expired';
          } else {
            nextStatus = 'provisioning';
          }

          setStatus(nextStatus);

          if (view.connect_tunnel_url) {
            setTunnelUrl((prev) => prev ?? view.connect_tunnel_url);
          }

          if (view.connect_error) {
            setError(view.connect_error);
          }

          // Terminal statuses — stop polling.
          if (
            nextStatus === 'ready' ||
            nextStatus === 'failed' ||
            nextStatus === 'ended' ||
            nextStatus === 'expired'
          ) {
            clearInterval(intervalRef.current!);
            intervalRef.current = null;
            setLoading(false);
          }
        } catch (err) {
          const msg = (err as { response?: { data?: { error?: string } }; message?: string })
            .response?.data?.error ?? (err as Error).message ?? 'Failed';
          setError(msg);
          setStatus('failed');
          setLoading(false);
          clearInterval(intervalRef.current!);
          intervalRef.current = null;
        }
      })();
    }, 2_000);

    intervalRef.current = interval;
  }, []);

  const end = useCallback(async (accountId: string): Promise<void> => {
    // Best-effort POST — swallow errors.
    try {
      await api.post(`/social-accounts/${accountId}/browse/end`);
    } catch {
      // silently swallowed
    }

    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    setLoading(false);
    setError(null);
    setStatus('idle');
    setTunnelUrl(null);
  }, []);

  return { loading, error, status, tunnelUrl, start, end };
}

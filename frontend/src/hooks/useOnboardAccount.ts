import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/client';

export type OnboardStatus =
  | 'idle'
  | 'starting'
  | 'provisioning'
  | 'ready'
  | 'failed'
  | 'expired'
  | 'completed';

/**
 * Drives the 3-screen FB account onboarding wizard:
 *   1. start(country)   -> POST /social-accounts/onboard, stores accountId
 *   2. poll             -> GET /social-accounts/:id/connect-status every 2s
 *                          until connect_status === 'ready' (tunnelUrl set)
 *                          or 'failed'/'expired' (error set)
 *   3. complete()       -> POST /social-accounts/:id/onboard-complete
 *
 * Mirrors useBrowseSession.ts: same 2s poll interval, same
 * cleanup-on-unmount, same error-extraction shape from axios errors.
 */
export function useOnboardAccount() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<OnboardStatus>('idle');
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

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

  // ── Private helper: begin polling /connect-status for accountId ──────────
  const beginPolling = useCallback((id: string): void => {
    const interval = setInterval(() => {
      void (async () => {
        try {
          const res = await api.get(`/social-accounts/${id}/connect-status`);
          const view = res.data.data as {
            connect_status: string | null;
            connect_tunnel_url: string | null;
            connect_error: string | null;
          };

          const s = view.connect_status ?? 'provisioning';
          let nextStatus: OnboardStatus;
          if (s === 'requested' || s === 'provisioning') {
            nextStatus = 'provisioning';
          } else if (s === 'ready') {
            nextStatus = 'ready';
          } else if (s === 'failed') {
            nextStatus = 'failed';
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
          if (nextStatus === 'ready' || nextStatus === 'failed' || nextStatus === 'expired') {
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

  // ── start: create the onboarding row then poll ────────────────────────
  const start = useCallback(async (country: string): Promise<void> => {
    // Cancel any existing poll before starting a new one.
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    setLoading(true);
    setError(null);
    setStatus('starting');
    setTunnelUrl(null);
    setAccountId(null);

    let newAccountId: string;
    try {
      const res = await api.post('/social-accounts/onboard', { country });
      newAccountId = (res.data.data as { accountId: string }).accountId;
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        .response?.data?.error ?? (err as Error).message ?? 'Failed to start onboarding';
      setError(msg);
      setStatus('failed');
      setLoading(false);
      return;
    }

    setAccountId(newAccountId);
    setStatus('provisioning');
    beginPolling(newAccountId);
  }, [beginPolling]);

  // ── complete: VA clicked Done — activate the account ──────────────────
  const complete = useCallback(async (): Promise<void> => {
    if (!accountId) return;
    try {
      await api.post(`/social-accounts/${accountId}/onboard-complete`);
      setStatus('completed');
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        .response?.data?.error ?? (err as Error).message ?? 'Failed to finish onboarding';
      setError(msg);
      throw err instanceof Error ? err : new Error(msg);
    }
  }, [accountId]);

  // ── reset: back to idle (used when the modal closes/reopens) ──────────
  const reset = useCallback((): void => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setLoading(false);
    setError(null);
    setStatus('idle');
    setTunnelUrl(null);
    setAccountId(null);
  }, []);

  return { loading, error, status, tunnelUrl, accountId, start, complete, reset };
}

import { useCallback, useState } from 'react';
import api from '../api/client';

export interface LeadAccountOption {
  id: string;
  display_name: string;
  handle: string | null;
  country: string | null;
  status: string;
  used_today: number;
  daily_cap: number | null;
  hourly_cap: number | null;
}

export interface LeadAccountsResult {
  country: string | null;
  accounts: LeadAccountOption[];
}

/**
 * Fetches the active FB accounts pinned to a lead's country (GET
 * /leads/:id/accounts, least-used first) so the "Open as James (hosted)"
 * flow can decide whether to auto-pick the single account, show a picker
 * for multiple, or show a friendly empty state. The country geo-guard
 * itself is enforced server-side — this hook only presents what the API
 * returns.
 *
 * `fetchAccounts` throws (rather than returning null) on failure so a
 * caller doing `await fetchAccounts(id)` inside the same tick gets the
 * exact error message straight from the catch block — reading the hook's
 * own `error` state right after the call would still show the prior
 * render's value, since the setState from inside fetchAccounts hasn't
 * flushed yet.
 */
export function useLeadAccounts() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAccounts = useCallback(async (leadId: string): Promise<LeadAccountsResult> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/leads/${leadId}/accounts`);
      return res.data.data as LeadAccountsResult;
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        .response?.data?.error ?? (err as Error).message ?? 'Failed to load accounts for this lead';
      setError(msg);
      throw new Error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, error, fetchAccounts };
}

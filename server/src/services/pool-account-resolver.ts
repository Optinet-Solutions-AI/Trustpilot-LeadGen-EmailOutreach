/**
 * resolvePoolAccountForCountry — shared "pick a pooled account by country" resolver.
 *
 * The Facebook account pool is country-keyed and NOT bound to a tool user: when
 * any operator picks a country, the system hands them a matching-country account
 * from the shared pool. This generalizes resolveLeadAccount's country fallback for
 * BOTH scrape jobs and hosted comment sessions.
 *
 * Selection:
 *   - platform='facebook', status='active' (a checkpointed account is status!='active'
 *     and is therefore excluded automatically), country=<country>.
 *   - ordered by comment_used_today ascending (spread the write load).
 *   - when excludeBusy (default true), skip accounts already occupied by a browse
 *     session (connect_status in BROWSE_ACTIVE_STATES) so two operators never drive
 *     the same account's browser at once.
 *
 * Returns null when no eligible account is found (caller must 409).
 */
import { getSupabase } from '../lib/supabase.js';
import { BROWSE_ACTIVE_STATES } from '../db/social-connect-requests.js';
import type { ResolvedAccount } from './lead-account-resolver.js';

interface PoolCandidate {
  id: string;
  country: string | null;
  comment_used_today: number | null;
  connect_status: string | null;
}

const BUSY_STATES = BROWSE_ACTIVE_STATES as readonly string[];

export async function resolvePoolAccountForCountry(
  country: string,
  opts: { excludeBusy?: boolean } = {},
): Promise<ResolvedAccount | null> {
  const excludeBusy = opts.excludeBusy ?? true;

  const { data, error } = await getSupabase()
    .from('social_accounts')
    .select('id, country, comment_used_today, connect_status')
    .eq('platform', 'facebook')
    .eq('status', 'active')
    .eq('country', country)
    .order('comment_used_today', { ascending: true });

  if (error) {
    throw new Error(`resolvePoolAccountForCountry lookup: ${(error as { message: string }).message}`);
  }

  const candidates = (data ?? []) as PoolCandidate[];
  const eligible = candidates.find((c) =>
    excludeBusy ? !BUSY_STATES.includes(c.connect_status ?? '') : true,
  );

  if (!eligible) return null;
  return { account_id: eligible.id, country: eligible.country };
}

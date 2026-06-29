/**
 * resolveLeadAccount — shared account resolver for Facebook lead operations.
 *
 * Priority:
 *   1. lead_platform_presences.social_account_id (lead's own capturing account)
 *      — only if that account is currently active.
 *   2. Active facebook social_accounts row pinned to the lead's country.
 *
 * Returns null if no suitable account is found (caller must 409).
 * NEVER falls back to an arbitrary cross-country account.
 */
import { getSupabase } from '../lib/supabase.js';
import { resolvePoolAccountForCountry } from './pool-account-resolver.js';

export interface ResolvedAccount {
  account_id: string;
  country: string | null;
}

export async function resolveLeadAccount(lead_id: string): Promise<ResolvedAccount | null> {
  const supabase = getSupabase();

  // 1. Check presence row for the lead's own capturing account
  const { data: presences, error: presenceErr } = await supabase
    .from('lead_platform_presences')
    .select('social_account_id')
    .eq('lead_id', lead_id)
    .eq('platform', 'facebook')
    .not('social_account_id', 'is', null)
    .limit(1);
  if (presenceErr) throw new Error(`resolveLeadAccount presence lookup: ${presenceErr.message}`);

  const presenceSocialId = presences?.[0]?.social_account_id as string | null | undefined;
  if (presenceSocialId) {
    const { data: acct, error: acctErr } = await supabase
      .from('social_accounts')
      .select('id, country, status')
      .eq('id', presenceSocialId)
      .eq('status', 'active')
      .maybeSingle();
    if (acctErr) throw new Error(`resolveLeadAccount account lookup: ${acctErr.message}`);
    if (acct) {
      return { account_id: acct.id as string, country: acct.country as string | null };
    }
    // Account found but not active — fall through to country-based lookup
  }

  // 2. Country-based fallback — find the lead's country, then an active account there
  const { data: leadRow, error: leadErr } = await supabase
    .from('leads')
    .select('country')
    .eq('id', lead_id)
    .maybeSingle();
  if (leadErr) throw new Error(`resolveLeadAccount lead lookup: ${leadErr.message}`);

  const country = (leadRow as { country?: string | null } | null)?.country ?? null;

  // No country on the lead and no capturing account → cannot resolve safely.
  if (!country) return null;

  // Country fallback → delegate to the shared pool resolver so a free,
  // lowest-usage account is picked (skipping accounts busy in a browse session
  // or flipped to checkpoint). With a single account this returns it as before;
  // with several it spreads load across the country's pool for multiple users.
  return resolvePoolAccountForCountry(country);
}

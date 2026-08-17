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
 *
 * Also exports the manual account-picker helpers used by
 * GET /api/leads/:id/accounts and the accountId branch of
 * POST /api/leads/:id/browse:
 *   - listActiveAccountsForLead — active Facebook accounts pinned to the
 *     lead's country, for the picker UI.
 *   - validateAccountForLead — the geo guard for a user-chosen accountId.
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

export interface LeadAccountOption {
  id: string;
  display_name: string | null;
  handle: string;
  country: string | null;
  status: string;
  used_today: number;
  daily_cap: number;
  hourly_cap: number;
}

export interface LeadAccountsForPicker {
  country: string | null;
  accounts: LeadAccountOption[];
}

/**
 * listActiveAccountsForLead — powers the manual account-picker UI. Returns
 * every active Facebook account pinned to the lead's country, least-used
 * first, so the operator can choose instead of accepting the auto-pick from
 * resolveLeadAccount. Never selects encrypted_cookies or other FB credential
 * columns — this response shape reaches the frontend.
 */
export async function listActiveAccountsForLead(lead_id: string): Promise<LeadAccountsForPicker> {
  const supabase = getSupabase();

  const { data: leadRow, error: leadErr } = await supabase
    .from('leads')
    .select('country')
    .eq('id', lead_id)
    .maybeSingle();
  if (leadErr) throw new Error(`listActiveAccountsForLead lead lookup: ${leadErr.message}`);

  const country = (leadRow as { country?: string | null } | null)?.country ?? null;
  if (!country) return { country: null, accounts: [] };

  const { data, error } = await supabase
    .from('social_accounts')
    .select('id, display_name, handle, country, status, used_today, daily_cap, hourly_cap')
    .eq('platform', 'facebook')
    .eq('status', 'active')
    .eq('country', country)
    .order('used_today', { ascending: true });
  if (error) throw new Error(`listActiveAccountsForLead accounts lookup: ${error.message}`);

  return { country, accounts: (data ?? []) as LeadAccountOption[] };
}

/**
 * validateAccountForLead — the geo guard for the manual account-picker. A
 * user-chosen accountId must still be an active Facebook account pinned to
 * the lead's own country; otherwise POST /:id/browse must reject it with a
 * 400 rather than let a wrong-geo or inactive account through.
 */
export async function validateAccountForLead(
  accountId: string,
  lead_id: string,
): Promise<{ ok: true; account_id: string; country: string | null } | { ok: false; reason: string }> {
  const supabase = getSupabase();

  const { data: leadRow, error: leadErr } = await supabase
    .from('leads')
    .select('country')
    .eq('id', lead_id)
    .maybeSingle();
  if (leadErr) throw new Error(`validateAccountForLead lead lookup: ${leadErr.message}`);

  const leadCountry = (leadRow as { country?: string | null } | null)?.country ?? null;

  const { data: acct, error: acctErr } = await supabase
    .from('social_accounts')
    .select('id, country, status, platform')
    .eq('id', accountId)
    .maybeSingle();
  if (acctErr) throw new Error(`validateAccountForLead account lookup: ${acctErr.message}`);

  const account = acct as { id: string; country: string | null; status: string; platform: string } | null;

  if (
    !account ||
    account.platform !== 'facebook' ||
    account.status !== 'active' ||
    !leadCountry ||
    account.country !== leadCountry
  ) {
    return {
      ok: false,
      reason: `Chosen account is not an active Facebook account for this lead's country (${leadCountry ?? 'unknown'})`,
    };
  }

  return { ok: true, account_id: account.id, country: account.country };
}

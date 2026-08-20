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

/**
 * Warmup ramp for a pooled account's comment budget. A freshly-onboarded
 * account should not post at full cap on day one (that's a checkpoint magnet),
 * so the effective daily comment cap ramps over three weeks:
 *   week 1 → 1/day, week 2 → 2/day, week 3 → 3/day, day 21+ → full configured cap.
 * `warmupStartedAt` null means "not tracked / already warmed" → full cap
 * (preserves existing accounts that predate warmup tracking). Never exceeds the
 * configured cap. `now` is injected so the calculation stays pure/testable.
 */
export function effectiveCommentCap(
  configuredCap: number,
  warmupStartedAt: string | null,
  now: Date,
): number {
  if (!warmupStartedAt) return configuredCap;
  const days = Math.floor((now.getTime() - Date.parse(warmupStartedAt)) / 86_400_000);
  if (days >= 21) return configuredCap;
  const rampCap = days < 7 ? 1 : days < 14 ? 2 : 3;
  return Math.min(configuredCap, rampCap);
}

export async function resolvePoolAccountForCountry(
  country: string | null,
  opts: { excludeBusy?: boolean; platform?: string; requireCountry?: boolean } = {},
): Promise<ResolvedAccount | null> {
  const excludeBusy = opts.excludeBusy ?? true;
  const platform = opts.platform ?? 'facebook';
  // Facebook pins strictly by country (a country-keyed pool, never
  // cross-country). Instagram (and any future global platform) has a single /
  // global account and leads are often country-less — so it resolves an active
  // account with the country as a soft *preference* rather than a hard gate.
  const requireCountry = opts.requireCountry ?? true;

  if (requireCountry && !country) return null;

  let query = getSupabase()
    .from('social_accounts')
    .select('id, country, comment_used_today, connect_status')
    .eq('platform', platform)
    .eq('status', 'active');
  if (requireCountry) {
    query = query.eq('country', country as string);
  }
  const { data, error } = await query.order('comment_used_today', { ascending: true });

  if (error) {
    throw new Error(`resolvePoolAccountForCountry lookup: ${(error as { message: string }).message}`);
  }

  const candidates = (data ?? []) as PoolCandidate[];
  const isFree = (c: PoolCandidate) =>
    excludeBusy ? !BUSY_STATES.includes(c.connect_status ?? '') : true;

  // Soft country preference: when the country isn't strictly required but the
  // lead has one, take an eligible same-country account first, then any
  // eligible account of this platform.
  if (!requireCountry && country) {
    const same = candidates.find((c) => c.country === country && isFree(c));
    if (same) return { account_id: same.id, country: same.country };
  }
  const eligible = candidates.find(isFree);

  if (!eligible) return null;
  return { account_id: eligible.id, country: eligible.country };
}

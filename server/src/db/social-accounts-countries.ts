import { getSupabase } from '../lib/supabase.js';

/** Distinct countries that have at least one ACTIVE facebook account.
 * Drives the "active markets" FB scrape dropdown (Option A). */
export async function listActiveCountries(): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from('social_accounts')
    .select('country')
    .eq('platform', 'facebook')
    .eq('status', 'active')
    .not('country', 'is', null);
  if (error) throw new Error(`listActiveCountries: ${error.message}`);
  const seen = new Set<string>();
  for (const row of (data as { country: string | null }[]) ?? []) {
    if (row.country) seen.add(row.country);
  }
  return [...seen];
}

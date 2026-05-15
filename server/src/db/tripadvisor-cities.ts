import { getSupabase } from '../lib/supabase.js';

export interface TripAdvisorCity {
  geo_id: string;
  country_code: string;
  name: string;
  slug: string;
  rank: number;
}

/**
 * Active, ranked cities for a country. Scrape-runner consumes this list
 * verbatim — the order returned is the order each city gets scraped.
 */
export async function listActiveCitiesForCountry(countryCode: string): Promise<TripAdvisorCity[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('tripadvisor_cities')
    .select('geo_id,country_code,name,slug,rank')
    .eq('country_code', countryCode)
    .eq('active', true)
    .order('rank', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as TripAdvisorCity[];
}

/** Lightweight count used by GET /api/tripadvisor/cities for the cost advisory. */
export async function countActiveCitiesForCountry(countryCode: string): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('tripadvisor_cities')
    .select('*', { count: 'exact', head: true })
    .eq('country_code', countryCode)
    .eq('active', true);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

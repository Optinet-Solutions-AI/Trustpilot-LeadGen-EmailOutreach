import { getSupabase } from '../lib/supabase.js';

// Migration 032 generalized the taxonomy tables from Trustpilot-only
// to a multi-platform schema:
//   trustpilot_categories → platform_categories (PK now (platform, slug))
//   trustpilot_countries  → platform_countries  (PK now (platform, code))
// All existing rows were migrated with platform='trustpilot'. Callers
// that omit the platform arg get Trustpilot for backwards compatibility.
const DEFAULT_PLATFORM = 'trustpilot';

export interface TaxonomyCategoryRow {
  slug: string;
  parent_slug: string | null;
  display_name: string;
  sort_order: number;
  business_count: number | null;
  last_seen_at: string;
  created_at: string;
  platform?: string;
}

export interface TaxonomyCountryRow {
  code: string;
  name: string;
  last_seen_at: string;
  created_at: string;
  platform?: string;
}

export async function listCategories(platform: string = DEFAULT_PLATFORM): Promise<TaxonomyCategoryRow[]> {
  const supabase = getSupabase();
  // PostgREST enforces a server-side max-rows cap (1000 on Supabase by
  // default) — a single `.range()` past that limit is silently clamped.
  // Paginate explicitly so a ~3700-row taxonomy comes through whole.
  const PAGE = 1000;
  const all: TaxonomyCategoryRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('platform_categories')
      .select('*')
      .eq('platform', platform)
      .order('parent_slug', { ascending: true, nullsFirst: true })
      .order('sort_order', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...(data as TaxonomyCategoryRow[]));
    if (data.length < PAGE) break;
  }
  return all;
}

export async function listCountries(platform: string = DEFAULT_PLATFORM): Promise<TaxonomyCountryRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('platform_countries')
    .select('*')
    .eq('platform', platform)
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as TaxonomyCountryRow[];
}

export async function getMaxLastSeen(platform: string = DEFAULT_PLATFORM): Promise<string | null> {
  const supabase = getSupabase();
  const [{ data: cat }, { data: cty }] = await Promise.all([
    supabase
      .from('platform_categories')
      .select('last_seen_at')
      .eq('platform', platform)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('platform_countries')
      .select('last_seen_at')
      .eq('platform', platform)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const candidates = [cat?.last_seen_at, cty?.last_seen_at].filter(Boolean) as string[];
  if (candidates.length === 0) return null;
  return candidates.sort().pop() ?? null;
}

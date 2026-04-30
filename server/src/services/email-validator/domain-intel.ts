// 7-day cached domain-level intel: top MX, provider type, and catch-all flag.
// Catch-all probing is the slowest stage (one SMTP roundtrip per domain), so
// reusing the answer for every lead on the same domain is the single biggest
// performance win in the pipeline.

import { getSupabase } from '../../lib/supabase.js';
import type { ProviderType } from './dns-check.js';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DomainIntel {
  domain: string;
  mx_top: string | null;
  provider_type: ProviderType | null;
  is_catch_all: boolean | null;
  checked_at: string;
}

export async function getCachedDomainIntel(domain: string): Promise<DomainIntel | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('domain_email_intel')
    .select('*')
    .eq('domain', domain.toLowerCase())
    .maybeSingle();

  if (error) {
    console.error(`[domain-intel] read failed for ${domain}: ${error.message}`);
    return null;
  }
  if (!data) return null;

  // Stale → treat as cache miss
  const age = Date.now() - new Date(data.checked_at).getTime();
  if (age > CACHE_TTL_MS) return null;

  return data as DomainIntel;
}

export async function upsertDomainIntel(intel: Omit<DomainIntel, 'checked_at'>): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('domain_email_intel')
    .upsert({
      domain: intel.domain.toLowerCase(),
      mx_top: intel.mx_top,
      provider_type: intel.provider_type,
      is_catch_all: intel.is_catch_all,
      checked_at: new Date().toISOString(),
    });
  if (error) console.error(`[domain-intel] upsert failed for ${intel.domain}: ${error.message}`);
}

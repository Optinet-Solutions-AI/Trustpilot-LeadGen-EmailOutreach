import { getSupabase } from '../lib/supabase.js';

export interface LeadFilters {
  status?: string;
  country?: string;
  category?: string;
  search?: string;
  minRating?: number;
  maxRating?: number;
  page?: number;
  limit?: number;
}

export async function getLeads(filters: LeadFilters = {}) {
  const supabase = getSupabase();
  const page = filters.page || 1;
  const limit = filters.limit || 25;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('leads')
    .select('*', { count: 'exact' });

  if (filters.status) query = query.eq('outreach_status', filters.status);
  if (filters.country) query = query.eq('country', filters.country);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.minRating) query = query.gte('star_rating', filters.minRating);
  if (filters.maxRating) query = query.lte('star_rating', filters.maxRating);
  if (filters.search) {
    query = query.or(`company_name.ilike.%${filters.search}%,website_url.ilike.%${filters.search}%,primary_email.ilike.%${filters.search}%`);
  }

  const { data, error, count } = await query
    .order('country', { ascending: true })
    .order('category', { ascending: true })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);

  return {
    data: data || [],
    total: count || 0,
    page,
    totalPages: Math.ceil((count || 0) / limit),
  };
}

export async function getLeadById(id: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('leads').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateLead(id: string, patch: Record<string, unknown>) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('leads').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function bulkUpdateLeads(ids: string[], patch: Record<string, unknown>) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('leads').update(patch).in('id', ids).select();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteLead(id: string) {
  const supabase = getSupabase();
  const { error } = await supabase.from('leads').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

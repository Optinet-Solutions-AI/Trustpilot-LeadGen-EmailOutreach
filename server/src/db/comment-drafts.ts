/**
 * Thin Supabase wrappers for the lead_comment_drafts table.
 *
 * Status lifecycle:
 *   draft → approved → posted
 *   draft → discarded
 *   approved → failed  (post_comment spawn returned posted=false)
 *
 * Pattern mirrors server/src/db/social-connect-requests.ts:
 * every function throws on supabase error so callers can catch uniformly.
 */
import { getSupabase } from '../lib/supabase.js';

export type DraftStatus = 'draft' | 'approved' | 'posted' | 'discarded' | 'failed';

export interface CommentDraftRow {
  id: string;
  lead_id: string;
  post_url: string;
  account_id: string;
  draft_text: string;
  status: DraftStatus;
  error: string | null;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── createDraft ───────────────────────────────────────────────────────────────
export async function createDraft(payload: {
  lead_id: string;
  post_url: string;
  account_id: string;
  draft_text: string;
}): Promise<CommentDraftRow> {
  const { data, error } = await getSupabase()
    .from('lead_comment_drafts')
    .insert({
      lead_id: payload.lead_id,
      post_url: payload.post_url,
      account_id: payload.account_id,
      draft_text: payload.draft_text,
      status: 'draft' as DraftStatus,
    })
    .select()
    .single();
  if (error) throw new Error(`createDraft: ${error.message}`);
  return data as CommentDraftRow;
}

// ── listDraftsForLead ─────────────────────────────────────────────────────────
export async function listDraftsForLead(lead_id: string): Promise<CommentDraftRow[]> {
  const { data, error } = await getSupabase()
    .from('lead_comment_drafts')
    .select('*')
    .eq('lead_id', lead_id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listDraftsForLead: ${error.message}`);
  return (data ?? []) as CommentDraftRow[];
}

// ── getDraft ──────────────────────────────────────────────────────────────────
export async function getDraft(id: string): Promise<CommentDraftRow | null> {
  const { data, error } = await getSupabase()
    .from('lead_comment_drafts')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getDraft: ${error.message}`);
  return data as CommentDraftRow | null;
}

// ── updateDraft ───────────────────────────────────────────────────────────────
export async function updateDraft(
  id: string,
  patch: { draft_text?: string; status?: DraftStatus },
): Promise<CommentDraftRow> {
  const { data, error } = await getSupabase()
    .from('lead_comment_drafts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`updateDraft: ${error.message}`);
  return data as CommentDraftRow;
}

// ── markPosted ────────────────────────────────────────────────────────────────
export async function markPosted(id: string): Promise<CommentDraftRow> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabase()
    .from('lead_comment_drafts')
    .update({ status: 'posted' as DraftStatus, posted_at: now, updated_at: now })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`markPosted: ${error.message}`);
  return data as CommentDraftRow;
}

// ── markFailed ────────────────────────────────────────────────────────────────
export async function markFailed(id: string, errorMsg: string): Promise<CommentDraftRow> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabase()
    .from('lead_comment_drafts')
    .update({ status: 'failed' as DraftStatus, error: errorMsg, updated_at: now })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`markFailed: ${error.message}`);
  return data as CommentDraftRow;
}

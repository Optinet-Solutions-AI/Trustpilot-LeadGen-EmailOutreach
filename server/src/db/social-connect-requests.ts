import crypto from 'crypto';
import { getSupabase } from '../lib/supabase.js';

export type ConnectStatus =
  | 'requested' | 'provisioning' | 'ready' | 'captured' | 'expired' | 'failed';

export interface ConnectRequestRow {
  id: string;
  connect_session_id: string | null;
  connect_status: ConnectStatus | null;
  connect_tunnel_url: string | null;
  connect_started_at: string | null;
  connect_expires_at: string | null;
  connect_error: string | null;
}

export interface ConnectStatusView {
  connect_status: ConnectStatus | null;
  connect_tunnel_url: string | null;
  connect_error: string | null;
  connect_expires_at: string | null;
}

const TTL_MS = 10 * 60 * 1000;

export async function enqueueConnectRequest(accountId: string): Promise<ConnectRequestRow> {
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MS);
  const { data, error } = await getSupabase()
    .from('social_accounts')
    .update({
      connect_session_id: sessionId,
      connect_status: 'requested' as ConnectStatus,
      connect_tunnel_url: null,
      connect_started_at: now.toISOString(),
      connect_expires_at: expires.toISOString(),
      connect_error: null,
    })
    .eq('id', accountId)
    .select('id, connect_session_id, connect_status, connect_tunnel_url, connect_started_at, connect_expires_at, connect_error')
    .single();
  if (error) throw new Error(`enqueueConnectRequest: ${error.message}`);
  return data as ConnectRequestRow;
}

export async function getConnectRequestStatus(accountId: string): Promise<ConnectStatusView> {
  const { data, error } = await getSupabase()
    .from('social_accounts')
    .select('connect_status, connect_tunnel_url, connect_error, connect_expires_at')
    .eq('id', accountId)
    .single();
  if (error) throw new Error(`getConnectRequestStatus: ${error.message}`);
  return data as ConnectStatusView;
}

// Worker-side: pick the oldest 'requested' row for this platform, atomically
// transition it to 'provisioning' to prevent double-claim. Returns null when
// no pending requests exist.
export async function claimPendingConnectRequest(platform: string): Promise<ConnectRequestRow | null> {
  const sb = getSupabase();
  const { data: candidates, error: selectErr } = await sb
    .from('social_accounts')
    .select('id, connect_session_id, connect_status, connect_tunnel_url, connect_started_at, connect_expires_at, connect_error')
    .eq('platform', platform)
    .eq('connect_status', 'requested')
    .order('connect_started_at', { ascending: true })
    .limit(1);
  if (selectErr) throw new Error(`claimPendingConnectRequest select: ${selectErr.message}`);
  const candidate = (candidates as ConnectRequestRow[] | null)?.[0];
  if (!candidate) return null;

  // Optimistic claim — only succeeds if the row is STILL 'requested' with
  // the same session_id. If another worker grabbed it first, this returns 0
  // rows and we just try again next tick.
  const { data: claimed, error: updateErr } = await sb
    .from('social_accounts')
    .update({ connect_status: 'provisioning' as ConnectStatus })
    .eq('id', candidate.id)
    .eq('connect_session_id', candidate.connect_session_id ?? '')
    .eq('connect_status', 'requested')
    .select('id, connect_session_id, connect_status, connect_tunnel_url, connect_started_at, connect_expires_at, connect_error')
    .single();
  if (updateErr) {
    // PGRST116 = no rows matched the WHERE — someone else claimed it. Not an error.
    if ((updateErr as { code?: string }).code === 'PGRST116') return null;
    throw new Error(`claimPendingConnectRequest update: ${updateErr.message}`);
  }
  return claimed as ConnectRequestRow;
}

export async function updateConnectStatus(
  accountId: string,
  patch: Partial<Pick<ConnectRequestRow, 'connect_status' | 'connect_tunnel_url' | 'connect_error'>>,
): Promise<void> {
  const { error } = await getSupabase()
    .from('social_accounts')
    .update(patch)
    .eq('id', accountId);
  if (error) throw new Error(`updateConnectStatus: ${error.message}`);
}

// Final step on a successful capture — writes encrypted cookies AND flips
// the account to 'active', AND marks the connect row 'captured'. One atomic
// update so a partial failure can't leave a 'captured' row without cookies.
export async function finalizeConnectRequest(
  accountId: string,
  encryptedCookies: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from('social_accounts')
    .update({
      encrypted_cookies: encryptedCookies,
      status: 'active',
      connect_status: 'captured' as ConnectStatus,
      last_login_at: new Date().toISOString(),
    })
    .eq('id', accountId);
  if (error) throw new Error(`finalizeConnectRequest: ${error.message}`);
}

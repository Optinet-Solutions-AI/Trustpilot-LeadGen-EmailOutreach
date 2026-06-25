import crypto from 'crypto';
import { getSupabase } from '../lib/supabase.js';

export type ConnectStatus =
  | 'requested' | 'provisioning' | 'ready' | 'captured' | 'expired' | 'failed'
  | 'active' | 'ended';

export const BROWSE_ACTIVE_STATES = ['requested', 'provisioning', 'ready', 'active'] as const;

export class AccountInUseError extends Error {
  constructor(public heldBy: string | null, public expiresAt: string | null) {
    super(`account in use by ${heldBy ?? 'another user'}`);
    this.name = 'AccountInUseError';
  }
}

export interface ConnectRequestRow {
  id: string;
  connect_session_id: string | null;
  connect_status: ConnectStatus | null;
  connect_tunnel_url: string | null;
  connect_started_at: string | null;
  connect_expires_at: string | null;
  connect_error: string | null;
  connect_mode: string | null;
  connect_target_url: string | null;
}

export interface ConnectStatusView {
  connect_status: ConnectStatus | null;
  connect_tunnel_url: string | null;
  connect_error: string | null;
  connect_expires_at: string | null;
}

// 45 min covers human captcha-solving + active browsing time in a remote session.
export const TTL_MS = 45 * 60 * 1000;

export async function enqueueConnectRequest(accountId: string): Promise<ConnectRequestRow> {
  const sb = getSupabase();

  // I2: refuse to stomp an in-flight browse session with a Re-login request.
  const { data: cur, error: readErr } = await sb
    .from('social_accounts')
    .select('connect_status, connect_mode, connect_requested_by, connect_expires_at')
    .eq('id', accountId)
    .single();
  if (readErr && (readErr as { code?: string }).code !== 'PGRST116') {
    throw new Error(`enqueueConnectRequest read: ${readErr.message}`);
  }
  if (
    cur &&
    cur.connect_mode === 'browse' &&
    (BROWSE_ACTIVE_STATES as readonly string[]).includes(cur.connect_status)
  ) {
    throw new AccountInUseError(
      cur.connect_requested_by ?? null,
      cur.connect_expires_at ?? null,
    );
  }

  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MS);
  // C1: always reset connect_mode to 'connect' so the worker takes the
  // cookie-capture branch (not the browse branch) after any prior browse session.
  const { data, error } = await sb
    .from('social_accounts')
    .update({
      connect_mode: 'connect',
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
    .select('id, connect_session_id, connect_status, connect_tunnel_url, connect_started_at, connect_expires_at, connect_error, connect_mode, connect_target_url')
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
    .select('id, connect_session_id, connect_status, connect_tunnel_url, connect_started_at, connect_expires_at, connect_error, connect_mode, connect_target_url')
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

export async function enqueueBrowseSession(
  accountId: string,
  opts: { targetUrl: string | null; requestedBy: string },
): Promise<ConnectRequestRow> {
  const sb = getSupabase();

  // Pre-read: populate heldBy/expiresAt for error reporting and early-exit on
  // an obvious active hit (gives a clean message in the common case).
  const { data: cur, error: e1 } = await sb
    .from('social_accounts')
    .select('connect_status, connect_mode, connect_requested_by, connect_expires_at')
    .eq('id', accountId)
    .single();
  if (e1) throw new Error(`enqueueBrowseSession read: ${e1.message}`);
  if (cur && (BROWSE_ACTIVE_STATES as readonly string[]).includes(cur.connect_status)) {
    throw new AccountInUseError(
      cur.connect_requested_by ?? null,
      cur.connect_expires_at ?? null,
    );
  }

  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MS);

  // I1: Make the UPDATE itself conditional so concurrent requests can't both
  // win. NULL-handling gotcha: `status NOT IN (...)` returns NULL for NULL rows
  // (won't match), so we must explicitly allow NULL with an .or().
  // PostgREST ANDs the .eq() and .or() together:
  //   id = X AND (connect_status IS NULL OR connect_status NOT IN (...))
  const { data: updated, error: e2 } = await sb
    .from('social_accounts')
    .update({
      connect_mode: 'browse',
      connect_session_id: sessionId,
      connect_status: 'requested' as ConnectStatus,
      connect_tunnel_url: null,
      connect_target_url: opts.targetUrl,
      connect_requested_by: opts.requestedBy,
      connect_started_at: now.toISOString(),
      connect_expires_at: expires.toISOString(),
      connect_error: null,
    })
    .eq('id', accountId)
    .or('connect_status.is.null,connect_status.not.in.("requested","provisioning","ready","active")')
    .select('id, connect_session_id, connect_status, connect_tunnel_url, connect_started_at, connect_expires_at, connect_error, connect_mode, connect_target_url')
    .single();

  if (e2) {
    // PGRST116 = 0 rows matched the conditional WHERE — lost the race.
    if ((e2 as { code?: string }).code === 'PGRST116') {
      throw new AccountInUseError(
        cur?.connect_requested_by ?? null,
        cur?.connect_expires_at ?? null,
      );
    }
    throw new Error(`enqueueBrowseSession: ${e2.message}`);
  }
  return updated as ConnectRequestRow;
}

export async function endBrowseSession(accountId: string): Promise<void> {
  // Guard on connect_mode='browse' so an accidental call with a connect-mode
  // account id can't clobber a live login session to 'ended'.
  const { error } = await getSupabase()
    .from('social_accounts')
    .update({ connect_status: 'ended' as ConnectStatus })
    .eq('id', accountId)
    .eq('connect_mode', 'browse');
  if (error) throw new Error(`endBrowseSession: ${error.message}`);
}

export async function getConnectStatusValue(accountId: string): Promise<string | null> {
  const { data, error } = await getSupabase().from('social_accounts')
    .select('connect_status').eq('id', accountId).single();
  if (error) return null;
  return (data as { connect_status: string | null }).connect_status;
}

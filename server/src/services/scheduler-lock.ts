/**
 * Leader election for the background send loops.
 *
 * The loops start on every Cloud Run instance and the service scales to 10.
 * Each instance judged the per-mailbox cap against a snapshot it took itself,
 * so ten instances could each permit a full cap. Measured 2026-09-19: two
 * mailboxes reached 25 against a cap of 20, and 70 emails went out against a
 * ceiling of 60. The in-process guard fixes a loop overlapping itself; it
 * cannot see the other nine.
 *
 * Acquiring is one atomic statement either way — an INSERT on the primary
 * key, or an UPDATE that only matches an already-expired row — so exactly one
 * instance wins. The lock carries an expiry because an instance can be killed
 * mid-tick and must not hold it for ever.
 *
 * If the table is missing the answer is `unavailable`, and the caller carries
 * on with the narrower protection it already had. The migration is applied by
 * hand, and a deploy that silently stopped every campaign because a table did
 * not exist yet would be worse than the fault being fixed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type LockOutcome = 'acquired' | 'held_by_other' | 'unavailable';

export function classifyLockError(
  error: unknown,
): 'none' | 'duplicate' | 'no_table' | 'error' {
  if (!error || typeof error !== 'object') return 'none';
  const e = error as { code?: string; message?: string };
  if (e.code === '23505') return 'duplicate';
  // 42P01 is Postgres; PGRST205 is PostgREST's schema cache saying the same.
  if (e.code === '42P01' || e.code === 'PGRST205') return 'no_table';
  if (typeof e.message === 'string' && /scheduler_locks.*does not exist|Could not find the table/i.test(e.message)) {
    return 'no_table';
  }
  return 'error';
}

export async function acquireSchedulerLock(
  supabase: SupabaseClient,
  name: string,
  holder: string,
  ttlMs: number,
): Promise<LockOutcome> {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const { error } = await supabase
    .from('scheduler_locks')
    .insert({ name, holder, acquired_at: new Date().toISOString(), expires_at: expiresAt });

  const kind = classifyLockError(error);
  if (kind === 'none') return 'acquired';
  if (kind === 'no_table') return 'unavailable';
  if (kind === 'error') return 'unavailable';

  // Someone holds it. Take it over only if their claim has expired — this
  // UPDATE matches nothing while the holder is alive, which is the guarantee.
  try {
    const { data } = await supabase
      .from('scheduler_locks')
      .update({ holder, acquired_at: new Date().toISOString(), expires_at: expiresAt })
      .eq('name', name)
      .lt('expires_at', new Date().toISOString())
      .select('name');
    return (data ?? []).length > 0 ? 'acquired' : 'held_by_other';
  } catch {
    return 'unavailable';
  }
}

/** Push the expiry out while a long tick is still running. */
export async function renewSchedulerLock(
  supabase: SupabaseClient,
  name: string,
  holder: string,
  ttlMs: number,
): Promise<void> {
  try {
    await supabase
      .from('scheduler_locks')
      .update({ expires_at: new Date(Date.now() + ttlMs).toISOString() })
      .eq('name', name)
      .eq('holder', holder);
  } catch {
    // A failed renewal just means the lock lapses and another instance picks
    // the work up — safe, and not worth failing the tick over.
  }
}

/** Give the lock back at the end of a tick, so the next one need not wait. */
export async function releaseSchedulerLock(
  supabase: SupabaseClient,
  name: string,
  holder: string,
): Promise<void> {
  try {
    await supabase.from('scheduler_locks').delete().eq('name', name).eq('holder', holder);
  } catch {
    // Expiry covers this.
  }
}

/** Stable per-process identity, so a holder can recognise its own lock. */
export const INSTANCE_ID = `${process.env.K_REVISION ?? 'local'}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

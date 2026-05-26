/**
 * Sender account loader — shared by campaign-scheduler (pool build) and
 * sequence-scheduler (per-lead lookup so a follow-up goes from the same
 * inbox as the initial email).
 *
 * Mirrors the DB row → SenderAccount mapping that lived inside
 * buildSenderPool() in campaign-scheduler.ts, but factored out so a single
 * sender can be loaded by email without spinning up the full pool.
 */

import { getSupabase } from '../lib/supabase.js';
import { createGmailClientFromCredentials } from './gmail-client.js';
import { getRampedDailyCap } from './rate-limiter.js';
import { config } from '../config.js';
import type { SenderAccount, GmailSenderAccount, SmtpSenderAccount } from './email-sender.js';

const SENDER_COLUMNS =
  'id, email, from_name, auth_type, gmail_client_id, gmail_client_secret, gmail_refresh_token, ' +
  'smtp_host, smtp_port, smtp_user, smtp_password, imap_host, imap_port, imap_user, imap_pass, ' +
  'daily_cap, hourly_cap, is_cold_sender, warmup_started_at, warmup_target_cap, warmup_ramp_days, status';

export type SenderAccountWithCaps = SenderAccount & { dailyCap: number; hourlyCap: number };

function mapRow(a: Record<string, unknown>): SenderAccountWithCaps | null {
  const dailyCap = getRampedDailyCap({
    warmup_started_at: (a.warmup_started_at as string | null | undefined) ?? null,
    warmup_target_cap: (a.warmup_target_cap as number | null | undefined) ?? 50,
    warmup_ramp_days:  (a.warmup_ramp_days  as number | null | undefined) ?? 21,
    daily_cap:         (a.daily_cap         as number | null | undefined) ?? null,
  });
  const hourlyCap = (a.hourly_cap as number | null | undefined) ?? config.rateLimits.hourlyCap;

  if (a.auth_type === 'smtp' && a.smtp_host && a.smtp_user && a.smtp_password) {
    return {
      email: a.email as string,
      fromName: a.from_name as string,
      auth_type: 'smtp',
      smtp_host: a.smtp_host as string,
      smtp_port: (a.smtp_port as number | null) ?? 587,
      smtp_user: a.smtp_user as string,
      smtp_password: a.smtp_password as string,
      imap_host: (a.imap_host as string | null) ?? null,
      imap_port: (a.imap_port as number | null) ?? null,
      imap_user: (a.imap_user as string | null) ?? null,
      imap_pass: (a.imap_pass as string | null) ?? null,
      dailyCap,
      hourlyCap,
    } as SenderAccountWithCaps;
  }

  if ((a.auth_type === 'gmail_oauth' || a.auth_type === 'app_password')
      && a.gmail_client_id && a.gmail_client_secret && a.gmail_refresh_token) {
    return {
      email: a.email as string,
      fromName: a.from_name as string,
      gmail: createGmailClientFromCredentials(
        a.gmail_client_id as string,
        a.gmail_client_secret as string,
        a.gmail_refresh_token as string,
      ),
      dailyCap,
      hourlyCap,
    } as SenderAccountWithCaps & GmailSenderAccount;
  }

  return null;
}

/**
 * Load a single sender account by its email address.
 *
 * Used by sequence-scheduler to keep follow-ups on the same inbox that
 * sent the initial email. Returns null when:
 *   - email_accounts row doesn't exist
 *   - account is not active / not a cold-sender
 *   - credentials are incomplete for the chosen auth_type
 *
 * Callers should treat null as "fall back to env default sender".
 */
export async function getSenderAccountByEmail(email: string): Promise<SenderAccountWithCaps | null> {
  if (!email) return null;
  try {
    const { data, error } = await getSupabase()
      .from('email_accounts')
      .select(SENDER_COLUMNS)
      .eq('status', 'active')
      .eq('is_cold_sender', true)
      .ilike('email', email)
      .in('auth_type', ['gmail_oauth', 'smtp', 'app_password'])
      .maybeSingle();

    if (error || !data) return null;
    return mapRow(data as unknown as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Load any email_accounts row that has valid sender creds — used by utility
 * sends like the duplicate-send monitor's alert email or any other internal
 * notification path. Deliberately looser filters than getSenderAccountByEmail:
 *   - DOES NOT require status='active' — operator pauses (status='paused')
 *     should not silence the monitor that watches for those very issues
 *   - DOES NOT require is_cold_sender=true — warmup peers can legitimately
 *     send utility mail without polluting the cold-outreach pool
 *   - DOES still require an auth_type with full creds attached, since a
 *     credential-less row can't actually send mail
 *
 * Callers should treat null as "the address you configured isn't a working
 * mailbox in email_accounts" — refuse to send rather than fall back.
 */
export async function getAccountForUtilitySend(email: string): Promise<SenderAccountWithCaps | null> {
  if (!email) return null;
  try {
    const { data, error } = await getSupabase()
      .from('email_accounts')
      .select(SENDER_COLUMNS)
      .ilike('email', email)
      .in('auth_type', ['gmail_oauth', 'smtp', 'app_password'])
      .maybeSingle();

    if (error || !data) return null;
    return mapRow(data as unknown as Record<string, unknown>);
  } catch {
    return null;
  }
}

export type { GmailSenderAccount, SmtpSenderAccount, SenderAccount };

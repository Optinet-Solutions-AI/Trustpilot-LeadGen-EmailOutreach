/**
 * Email rate limiter with warmup tracking.
 *
 * Warmup schedule caps daily sends to protect domain reputation:
 *   Days  1-3  → 10/day
 *   Days  4-7  → 20/day
 *   Days  8-14 → 30/day
 *   Days 15-21 → 40/day
 *   Day  22+   → configured EMAIL_DAILY_CAP
 *
 * Warmup state (start date + lifetime sends) is persisted to Supabase
 * so it survives Cloud Run restarts and re-deploys.
 */

import { config } from '../config.js';
import { getSupabase } from '../lib/supabase.js';

const WARMUP_SCHEDULE = [
  { maxDay: 3,  cap: 10 },
  { maxDay: 7,  cap: 20 },
  { maxDay: 14, cap: 30 },
  { maxDay: 21, cap: 40 },
];

// Key used for the single-row warmup record in Supabase
// (one row per sending account; we use the primary from-email as the key)
function warmupKey(): string {
  return config.gmail.fromEmail || config.brevo.fromEmail || 'default';
}

interface WarmupState {
  startDate: string;    // ISO timestamp of first-ever send
  lifetimeSent: number;
}

class EmailRateLimiter {
  // ── In-memory counters (reset on restart — intentional for hourly/daily windows) ──
  private hourlyCount = 0;
  private dailyCount  = 0;
  private hourlyWindowStart = Date.now();
  private dailyWindowStart  = Date.now();

  // ── Warmup — loaded from DB on first use ────────────────────────────────
  private warmup: WarmupState = { startDate: new Date().toISOString(), lifetimeSent: 0 };
  private warmupLoaded = false;
  private warmupLoading: Promise<void> | null = null;

  // ── Initialise warmup from Supabase (called lazily on first canSend/recordSend) ──
  private async ensureWarmupLoaded(): Promise<void> {
    if (this.warmupLoaded) return;
    if (this.warmupLoading) return this.warmupLoading;

    this.warmupLoading = (async () => {
      try {
        const supabase = getSupabase();
        const { data } = await supabase
          .from('email_warmup_state')
          .select('start_date, lifetime_sent')
          .eq('account_email', warmupKey())
          .single();

        if (data) {
          this.warmup = { startDate: data.start_date, lifetimeSent: data.lifetime_sent };
        } else {
          // First run — create the row
          await supabase.from('email_warmup_state').insert({
            account_email: warmupKey(),
            start_date: this.warmup.startDate,
            lifetime_sent: 0,
          });
        }
      } catch (err) {
        // Non-fatal — fall back to in-memory defaults
        console.warn('[RateLimit] Could not load warmup state from DB:', err instanceof Error ? err.message : err);
      } finally {
        this.warmupLoaded = true;
        this.warmupLoading = null;
      }
    })();

    return this.warmupLoading;
  }

  private async persistWarmup(): Promise<void> {
    try {
      await getSupabase()
        .from('email_warmup_state')
        .upsert({
          account_email: warmupKey(),
          start_date:    this.warmup.startDate,
          lifetime_sent: this.warmup.lifetimeSent,
          updated_at:    new Date().toISOString(),
        }, { onConflict: 'account_email' });
    } catch (err) {
      console.warn('[RateLimit] Could not persist warmup state:', err instanceof Error ? err.message : err);
    }
  }

  private resetIfNeeded() {
    const now = Date.now();
    if (now - this.hourlyWindowStart >= 60 * 60 * 1000) {
      this.hourlyCount = 0;
      this.hourlyWindowStart = now;
    }
    if (now - this.dailyWindowStart >= 24 * 60 * 60 * 1000) {
      this.dailyCount = 0;
      this.dailyWindowStart = now;
    }
  }

  getWarmupDay(): number {
    const startMs = new Date(this.warmup.startDate).getTime();
    return Math.max(1, Math.floor((Date.now() - startMs) / (24 * 60 * 60 * 1000)) + 1);
  }

  getEffectiveDailyCap(): number {
    const day = this.getWarmupDay();
    for (const entry of WARMUP_SCHEDULE) {
      if (day <= entry.maxDay) return Math.min(config.rateLimits.dailyCap, entry.cap);
    }
    return config.rateLimits.dailyCap;
  }

  canSend(): boolean {
    this.resetIfNeeded();
    return (
      this.hourlyCount < config.rateLimits.hourlyCap &&
      this.dailyCount  < this.getEffectiveDailyCap()
    );
  }

  recordSend() {
    this.hourlyCount++;
    this.dailyCount++;
    this.warmup.lifetimeSent++;
    // Persist async — don't block the send loop
    this.persistWarmup().catch(() => {});
  }

  getStatus() {
    this.resetIfNeeded();
    const effectiveDailyCap = this.getEffectiveDailyCap();
    return {
      hourlyCount:     this.hourlyCount,
      hourlyCap:       config.rateLimits.hourlyCap,
      hourlyRemaining: Math.max(0, config.rateLimits.hourlyCap - this.hourlyCount),
      hourlyResetAt:   new Date(this.hourlyWindowStart + 60 * 60 * 1000).toISOString(),
      dailyCount:      this.dailyCount,
      dailyCap:        effectiveDailyCap,
      dailyRemaining:  Math.max(0, effectiveDailyCap - this.dailyCount),
      dailyResetAt:    new Date(this.dailyWindowStart + 24 * 60 * 60 * 1000).toISOString(),
      canSend:         this.canSend(),
    };
  }

  getWarmupStatus() {
    const day        = this.getWarmupDay();
    const currentCap = this.getEffectiveDailyCap();
    const phase =
      day <= 3  ? 'Early warmup'        :
      day <= 7  ? 'Warming up'          :
      day <= 14 ? 'Building reputation' :
      day <= 21 ? 'Scaling up'          :
      'Full speed';

    return {
      day,
      currentCap,
      configuredCap: config.rateLimits.dailyCap,
      lifetimeSent:  this.warmup.lifetimeSent,
      startDate:     this.warmup.startDate,
      phase,
      isWarmedUp:    day > 21,
    };
  }

  /** Load warmup state from DB (call once at server start) */
  async init(): Promise<void> {
    await this.ensureWarmupLoaded();
    const ws = this.getWarmupStatus();
    console.log(`[RateLimit] Warmup: day ${ws.day} (${ws.phase}), cap ${ws.currentCap}/day, lifetime sends: ${ws.lifetimeSent}`);
  }

  /** Block until rate limiter allows sending, polling every 10s */
  async waitUntilCanSend(logPrefix = ''): Promise<void> {
    await this.ensureWarmupLoaded();
    while (!this.canSend()) {
      const status = this.getStatus();
      const blockedBy = status.hourlyRemaining === 0 ? 'hourly' : 'daily';
      const resetAt   = blockedBy === 'hourly' ? status.hourlyResetAt : status.dailyResetAt;
      const capInfo   = blockedBy === 'daily'
        ? `warmup day ${this.getWarmupDay()}, cap ${status.dailyCap}`
        : `cap ${status.hourlyCap}`;
      console.log(`${logPrefix}[RateLimit] ${blockedBy} cap reached (${capInfo}), waiting until ${resetAt}…`);
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
}

export const rateLimiter = new EmailRateLimiter();

/**
 * Per-account ramped daily cap.
 *
 * Ramps linearly from a Day-1 floor of 10 up to `warmup_target_cap` over
 * `warmup_ramp_days` days, starting from `warmup_started_at`. If the account
 * has no warmup_started_at, the static `daily_cap` (or env default) is used.
 *
 * Used by campaign-scheduler.buildSenderPool() to enforce per-account ramps
 * independent of the global env-keyed warmup state.
 */
export function getRampedDailyCap(account: {
  warmup_started_at: string | null;
  warmup_target_cap: number;
  warmup_ramp_days: number;
  daily_cap: number | null;
}): number {
  if (!account.warmup_started_at) {
    return account.daily_cap ?? config.rateLimits.dailyCap;
  }

  const startMs = new Date(account.warmup_started_at).getTime();
  const dayN = Math.max(1, Math.floor((Date.now() - startMs) / 86_400_000) + 1);
  const target = account.warmup_target_cap;
  const ramp = Math.max(2, account.warmup_ramp_days); // avoid div-by-zero on N=1

  if (dayN >= ramp) return target;

  const floor = 10;
  const cap = Math.round(floor + (target - floor) * (dayN - 1) / (ramp - 1));
  return Math.max(floor, cap);
}

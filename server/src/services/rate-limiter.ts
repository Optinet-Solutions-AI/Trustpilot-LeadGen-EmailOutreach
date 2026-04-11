/**
 * In-memory email rate limiter with warmup tracking.
 * Tracks hourly and daily send counts to protect domain reputation.
 * Warmup state (lifetime sends + start date) is persisted to .tmp/warmup-state.json
 * so caps survive server restarts.
 */

import { config } from '../config.js';
import fs from 'fs';
import path from 'path';

// Warmup schedule: days 1-3 = 10/day, 4-7 = 20/day, 8-14 = 30/day, 15-21 = 40/day, 22+ = config cap
const WARMUP_SCHEDULE = [
  { maxDay: 3,  cap: 10 },
  { maxDay: 7,  cap: 20 },
  { maxDay: 14, cap: 30 },
  { maxDay: 21, cap: 40 },
];

interface WarmupState {
  startDate: string;   // ISO date of first send
  lifetimeSent: number;
}

function getWarmupStatePath(): string {
  return path.resolve(process.cwd(), '.tmp', 'warmup-state.json');
}

function loadWarmupState(): WarmupState {
  try {
    const raw = fs.readFileSync(getWarmupStatePath(), 'utf-8');
    return JSON.parse(raw) as WarmupState;
  } catch {
    return { startDate: new Date().toISOString(), lifetimeSent: 0 };
  }
}

function saveWarmupState(state: WarmupState): void {
  try {
    const dir = path.dirname(getWarmupStatePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getWarmupStatePath(), JSON.stringify(state, null, 2));
  } catch {
    // Non-critical — continue without persistence
  }
}

class EmailRateLimiter {
  private hourlyCount = 0;
  private dailyCount = 0;
  private hourlyWindowStart = Date.now();
  private dailyWindowStart = Date.now();
  private warmup: WarmupState;

  constructor() {
    this.warmup = loadWarmupState();
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

  /** Calculate the current warmup day (1-based) */
  getWarmupDay(): number {
    const startMs = new Date(this.warmup.startDate).getTime();
    return Math.max(1, Math.floor((Date.now() - startMs) / (24 * 60 * 60 * 1000)) + 1);
  }

  /** Calculate effective daily cap based on warmup schedule */
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
      this.dailyCount < this.getEffectiveDailyCap()
    );
  }

  recordSend() {
    this.hourlyCount++;
    this.dailyCount++;
    this.warmup.lifetimeSent++;
    saveWarmupState(this.warmup);
  }

  getStatus() {
    this.resetIfNeeded();
    const effectiveDailyCap = this.getEffectiveDailyCap();
    const hourlyRemaining = Math.max(0, config.rateLimits.hourlyCap - this.hourlyCount);
    const dailyRemaining = Math.max(0, effectiveDailyCap - this.dailyCount);

    const hourlyResetAt = new Date(this.hourlyWindowStart + 60 * 60 * 1000).toISOString();
    const dailyResetAt = new Date(this.dailyWindowStart + 24 * 60 * 60 * 1000).toISOString();

    return {
      hourlyCount: this.hourlyCount,
      hourlyCap: config.rateLimits.hourlyCap,
      hourlyRemaining,
      hourlyResetAt,
      dailyCount: this.dailyCount,
      dailyCap: effectiveDailyCap,
      dailyRemaining,
      dailyResetAt,
      canSend: this.canSend(),
    };
  }

  getWarmupStatus() {
    const day = this.getWarmupDay();
    const currentCap = this.getEffectiveDailyCap();
    const configuredCap = config.rateLimits.dailyCap;
    const phase =
      day <= 3  ? 'Early warmup' :
      day <= 7  ? 'Warming up'   :
      day <= 14 ? 'Building reputation' :
      day <= 21 ? 'Scaling up'   :
      'Full speed';

    return {
      day,
      currentCap,
      configuredCap,
      lifetimeSent: this.warmup.lifetimeSent,
      startDate: this.warmup.startDate,
      phase,
      isWarmedUp: day > 21,
    };
  }

  /** Wait until rate limiter allows sending, polling every 10s */
  async waitUntilCanSend(logPrefix = ''): Promise<void> {
    while (!this.canSend()) {
      const status = this.getStatus();
      const blockedBy = status.hourlyRemaining === 0 ? 'hourly' : 'daily';
      const resetAt = blockedBy === 'hourly' ? status.hourlyResetAt : status.dailyResetAt;
      console.log(`${logPrefix}[RateLimit] ${blockedBy} cap reached (${blockedBy === 'daily' ? `warmup day ${this.getWarmupDay()}, cap ${status.dailyCap}` : `cap ${status.hourlyCap}`}), waiting until ${resetAt}...`);
      await sleep(10_000);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Singleton instance
export const rateLimiter = new EmailRateLimiter();

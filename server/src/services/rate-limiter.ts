/**
 * In-memory email rate limiter.
 * Tracks hourly and daily send counts to protect domain reputation.
 * Resets are time-window based (not server-restart based for those windows).
 */

import { config } from '../config.js';

class EmailRateLimiter {
  private hourlyCount = 0;
  private dailyCount = 0;
  private hourlyWindowStart = Date.now();
  private dailyWindowStart = Date.now();

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

  canSend(): boolean {
    this.resetIfNeeded();
    return (
      this.hourlyCount < config.rateLimits.hourlyCap &&
      this.dailyCount < config.rateLimits.dailyCap
    );
  }

  recordSend() {
    this.hourlyCount++;
    this.dailyCount++;
  }

  getStatus() {
    this.resetIfNeeded();
    const hourlyRemaining = Math.max(0, config.rateLimits.hourlyCap - this.hourlyCount);
    const dailyRemaining = Math.max(0, config.rateLimits.dailyCap - this.dailyCount);

    // Time until next window opens (hourly is the tighter constraint usually)
    const hourlyResetAt = new Date(this.hourlyWindowStart + 60 * 60 * 1000).toISOString();
    const dailyResetAt = new Date(this.dailyWindowStart + 24 * 60 * 60 * 1000).toISOString();

    return {
      hourlyCount: this.hourlyCount,
      hourlyCap: config.rateLimits.hourlyCap,
      hourlyRemaining,
      hourlyResetAt,
      dailyCount: this.dailyCount,
      dailyCap: config.rateLimits.dailyCap,
      dailyRemaining,
      dailyResetAt,
      canSend: this.canSend(),
    };
  }

  /** Wait until rate limiter allows sending, polling every 10s */
  async waitUntilCanSend(logPrefix = ''): Promise<void> {
    while (!this.canSend()) {
      const status = this.getStatus();
      const blockedBy = status.hourlyRemaining === 0 ? 'hourly' : 'daily';
      const resetAt = blockedBy === 'hourly' ? status.hourlyResetAt : status.dailyResetAt;
      console.log(`${logPrefix}[RateLimit] ${blockedBy} cap reached, waiting until ${resetAt}...`);
      await sleep(10_000);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Singleton instance
export const rateLimiter = new EmailRateLimiter();

# Nightly Scrape Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-process daemon that scrapes the full 16-country × 22-category matrix inside a daily Asia/Manila window (default 00:00–14:00), one-click toggleable from the Scrape page, with isolation-first reliability so one failure never kills the whole night.

**Architecture:** New `setInterval`-based scheduler service (matches existing `campaign-scheduler`, `warmup-scheduler`, etc.). Reads/writes a new `app_settings` row, dequeues eligible combos from the static target list, spawns via existing `runScrapeJob()` plumbing tagged `source='nightly'`. Three reliability guards: tick heartbeat in DB, 30-min per-job wall-clock cap, and 3-consecutive-failure auto-pause.

**Tech Stack:** Node 22 + TypeScript (server), Express, Supabase (Postgres), React + Vite + Tailwind (frontend), Playwright via Python child processes (existing). No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-11-nightly-scrape-scheduler-design.md`](../specs/2026-05-11-nightly-scrape-scheduler-design.md)

---

## File map

**Create:**
- `supabase/migrations/029_nightly_scrape_schedule.sql`
- `server/src/services/scrape-targets.ts`
- `server/src/db/app-settings.ts`
- `server/src/services/nightly-scrape-scheduler.ts`
- `server/src/routes/scrape-schedule.ts`
- `frontend/src/hooks/useSchedule.ts`
- `frontend/src/components/NightlyScheduleCard.tsx`

**Modify:**
- `server/src/services/scrape-runner.ts` — extend `ScrapeParams` with `source?: 'manual' | 'nightly'`, pass to `createJob`
- `server/src/db/scrape-jobs.ts` — add `source` to `createJob` params type
- `server/src/routes/scrape.ts` — default `source='manual'` on the existing scrape route
- `server/src/server.ts` — mount `/api/scrape/schedule` routes, call `startNightlyScrapeScheduler()` on boot
- `frontend/src/components/ScrapeForm.tsx` — add 3 Finance category slugs
- `frontend/src/views/Scrape.tsx` — render `<NightlyScheduleCard />` below the existing config card

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/029_nightly_scrape_schedule.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 029_nightly_scrape_schedule.sql
-- Adds app_settings (single-row) for the nightly scrape scheduler,
-- and tags scrape_jobs with `source` so manual vs scheduler jobs can be
-- distinguished for parallelism counting and the activity feed.

CREATE TABLE IF NOT EXISTS app_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  nightly_scrape_enabled bool NOT NULL DEFAULT false,
  nightly_scrape_start_hour int NOT NULL DEFAULT 0,
  nightly_scrape_end_hour int NOT NULL DEFAULT 14,
  nightly_scrape_timezone text NOT NULL DEFAULT 'Asia/Manila',
  nightly_scrape_rescrape_days int NOT NULL DEFAULT 7,
  nightly_scrape_parallelism int NOT NULL DEFAULT 2,
  nightly_scrape_verify bool NOT NULL DEFAULT true,
  nightly_scrape_min_rating real NOT NULL DEFAULT 1.0,
  nightly_scrape_max_rating real NOT NULL DEFAULT 3.5,
  nightly_scheduler_last_tick_at timestamptz,
  nightly_scheduler_paused_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_source_status_completed
  ON scrape_jobs (source, status, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_country_category_completed
  ON scrape_jobs (country, category, completed_at DESC)
  WHERE status = 'completed';
```

- [ ] **Step 2: Apply the migration in Supabase**

Open Supabase SQL Editor → paste the migration → Run. Expected: "Success. No rows returned."

- [ ] **Step 3: Verify schema**

In Supabase SQL Editor:

```sql
SELECT * FROM app_settings;
-- Expect: 1 row, nightly_scrape_enabled=false, nightly_scrape_timezone='Asia/Manila'

SELECT column_name FROM information_schema.columns
WHERE table_name='scrape_jobs' AND column_name='source';
-- Expect: 1 row returned
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/029_nightly_scrape_schedule.sql
git commit -m "feat(db): add app_settings and scrape_jobs.source for nightly scheduler"
```

---

## Task 2: Backend scrape targets constant

**Files:**
- Create: `server/src/services/scrape-targets.ts`

- [ ] **Step 1: Write the constants file**

```typescript
// Mirrors the COUNTRIES and CATEGORIES arrays in
// frontend/src/components/ScrapeForm.tsx. Single source of truth for
// the nightly scheduler. Keep these two lists in sync when adding new
// targets (manual UI and nightly batch share this matrix).

export const COUNTRIES: string[] = [
  'AU', 'AT', 'BR', 'CA', 'DK', 'FI', 'FR', 'DE',
  'IT', 'NL', 'NO', 'ES', 'SE', 'AE', 'GB', 'US',
];

export const CATEGORIES: string[] = [
  // Gambling
  'gambling',
  'casino',
  'online_casino_or_bookmaker',
  'online_sports_betting',
  'betting_agency',
  'bookmaker',
  'gambling_service',
  'gambling_house',
  'off_track_betting_shop',
  'lottery_vendor',
  'online_lottery_ticket_vendor',
  'lottery_retailer',
  'lottery_shop',
  'gambling_instructor',
  // Gaming
  'gaming',
  'gaming_service_provider',
  'bingo_hall',
  'video_game_store',
  'game_store',
  // Finance
  'money_insurance',
  'investing_wealth',
  'investment_service',
];
```

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/scrape-targets.ts
git commit -m "feat(scraper): add backend country and category target lists"
```

---

## Task 3: app_settings DB layer with clamping

**Files:**
- Create: `server/src/db/app-settings.ts`

- [ ] **Step 1: Write the DB layer**

```typescript
import { getSupabase } from '../lib/supabase.js';

export interface AppSettings {
  id: 1;
  nightly_scrape_enabled: boolean;
  nightly_scrape_start_hour: number;     // 0-23
  nightly_scrape_end_hour: number;       // 0-23
  nightly_scrape_timezone: string;       // IANA tz
  nightly_scrape_rescrape_days: number;  // 1-90
  nightly_scrape_parallelism: number;    // 1-5
  nightly_scrape_verify: boolean;
  nightly_scrape_min_rating: number;
  nightly_scrape_max_rating: number;
  nightly_scheduler_last_tick_at: string | null;
  nightly_scheduler_paused_reason: string | null;
  updated_at: string;
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(v) ? v : lo)));

const clampReal = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

function clampSettings(raw: AppSettings): AppSettings {
  return {
    ...raw,
    nightly_scrape_start_hour: clampInt(raw.nightly_scrape_start_hour, 0, 23),
    nightly_scrape_end_hour: clampInt(raw.nightly_scrape_end_hour, 0, 23),
    nightly_scrape_rescrape_days: clampInt(raw.nightly_scrape_rescrape_days, 1, 90),
    nightly_scrape_parallelism: clampInt(raw.nightly_scrape_parallelism, 1, 5),
    nightly_scrape_min_rating: clampReal(raw.nightly_scrape_min_rating, 1.0, 5.0),
    nightly_scrape_max_rating: clampReal(raw.nightly_scrape_max_rating, 1.0, 5.0),
  };
}

export async function getSettings(): Promise<AppSettings> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data) {
    // Self-heal if the migration default row was deleted.
    const { data: inserted, error: insErr } = await supabase
      .from('app_settings')
      .insert({ id: 1 })
      .select('*')
      .single();
    if (insErr) throw new Error(insErr.message);
    return clampSettings(inserted as AppSettings);
  }

  return clampSettings(data as AppSettings);
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('app_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return clampSettings(data as AppSettings);
}

export async function writeSchedulerTick(): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from('app_settings')
    .update({ nightly_scheduler_last_tick_at: new Date().toISOString() })
    .eq('id', 1);
}

export async function setPausedReason(reason: string | null): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from('app_settings')
    .update({ nightly_scheduler_paused_reason: reason })
    .eq('id', 1);
}
```

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/db/app-settings.ts
git commit -m "feat(db): add app-settings layer with read-time value clamping"
```

---

## Task 4: Tag scrape jobs with source

**Files:**
- Modify: `server/src/db/scrape-jobs.ts` (lines 3-19)
- Modify: `server/src/services/scrape-runner.ts` (lines 220-229, 523-524)
- Modify: `server/src/routes/scrape.ts` (lines 37-44, 62-72, 206-233)

- [ ] **Step 1: Extend `createJob` to accept `source`**

In `server/src/db/scrape-jobs.ts`, replace lines 3-19:

```typescript
export async function createJob(params: {
  country: string;
  category: string;
  min_rating: number;
  max_rating: number;
  enrich: boolean;
  verify: boolean;
  source?: 'manual' | 'nightly';
}) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_jobs')
    .insert({ ...params, source: params.source ?? 'manual' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}
```

- [ ] **Step 2: Extend `ScrapeParams` and forward source**

In `server/src/services/scrape-runner.ts`, replace the `ScrapeParams` interface at line 220:

```typescript
interface ScrapeParams {
  jobId: string;
  country: string;
  category: string;
  minRating: number;
  maxRating: number;
  enrich: boolean;
  verify: boolean;
  forceRescrape?: boolean;
  source?: 'manual' | 'nightly';
}
```

The `runScrapeJob` body itself does not need to change — the `source` is set at `createJob` time (Task 4 Step 1), and `runScrapeJob` reads the job row by id thereafter. The new field flows through automatically.

- [ ] **Step 3: Default `source='manual'` in the scrape route**

In `server/src/routes/scrape.ts` line 37, change the `createJob` call to pass source:

```typescript
const job = await createJob({
  country,
  category,
  min_rating: minRating,
  max_rating: maxRating,
  enrich,
  verify,
  source: 'manual',
});
```

Repeat for the retry-failed `createJob` call (around line 206):

```typescript
const retryJob = await createJob({
  country: job.country,
  category: job.category,
  min_rating: job.min_rating,
  max_rating: job.max_rating,
  enrich: job.enrich,
  verify: job.verify,
  source: 'manual',
});
```

- [ ] **Step 4: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/scrape-jobs.ts server/src/services/scrape-runner.ts server/src/routes/scrape.ts
git commit -m "feat(scraper): tag scrape jobs with source (manual|nightly)"
```

---

## Task 5: Nightly scheduler skeleton with tick heartbeat

**Files:**
- Create: `server/src/services/nightly-scrape-scheduler.ts`

- [ ] **Step 1: Write the skeleton**

```typescript
/**
 * Nightly Scrape Scheduler — DB-driven background daemon that runs
 * scrape jobs across the full country x category matrix inside a
 * configurable daily window (default 00:00-14:00 Asia/Manila).
 *
 * Each tick (every 60s):
 *   1. Write heartbeat to app_settings.nightly_scheduler_last_tick_at
 *   2. Cancel any source='nightly' jobs running > 30 min (wall-clock cap)
 *   3. Auto-pause check: if last 3 nightly completions are all failed+0 leads, disable
 *   4. If enabled + inside window + not paused: dequeue and spawn up to (parallelism - inflight)
 *
 * Every tick is wrapped in try/catch — the daemon never dies from one bad iteration.
 * Heartbeat is written FIRST so a stalled tick still shows as alive up to the last
 * successful tick (use the gap to detect dead daemons in the UI).
 */

import { getSettings, writeSchedulerTick, setPausedReason, updateSettings } from '../db/app-settings.js';

const POLL_INTERVAL_MS = 60_000;
const LOG_PREFIX = '[NightlyScheduler]';

// In-memory "run now" override: epoch ms until which the time-window
// check is bypassed. Process-local — lost on Cloud Run instance restart.
let runNowUntil: number | null = null;

export function setRunNowOverride(ttlMs = 4 * 60 * 60 * 1000): number {
  runNowUntil = Date.now() + ttlMs;
  return runNowUntil;
}

export function isRunNowActive(): boolean {
  return runNowUntil !== null && runNowUntil > Date.now();
}

export function startNightlyScrapeScheduler(): void {
  console.log(`${LOG_PREFIX} Started — polling every ${POLL_INTERVAL_MS / 1000}s`);

  setInterval(async () => {
    try {
      await tick();
    } catch (err) {
      console.error(`${LOG_PREFIX} tick error:`, err instanceof Error ? err.message : err);
    }
  }, POLL_INTERVAL_MS);
}

async function tick(): Promise<void> {
  // Always heartbeat first so even no-op ticks update liveness.
  await writeSchedulerTick();

  const settings = await getSettings();
  const enabled = settings.nightly_scrape_enabled;
  const runNow = isRunNowActive();

  if (!enabled && !runNow) return;
  if (settings.nightly_scheduler_paused_reason && !runNow) return;

  // Window check (skipped during run-now override)
  if (!runNow) {
    const hour = currentHourInTz(settings.nightly_scrape_timezone);
    const { nightly_scrape_start_hour: s, nightly_scrape_end_hour: e } = settings;
    const inWindow = s === e ? false : (s < e ? hour >= s && hour < e : hour >= s || hour < e);
    if (!inWindow) return;
  }

  // Logic for cap-cancel, auto-pause, and dequeue is added in later tasks.
  console.log(`${LOG_PREFIX} tick OK (enabled=${enabled} runNow=${runNow})`);
}

function currentHourInTz(timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    return Number(fmt.format(new Date()));
  } catch {
    // Bad timezone string — fall back to UTC rather than crash the tick.
    return new Date().getUTCHours();
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/nightly-scrape-scheduler.ts
git commit -m "feat(scraper): add nightly scheduler skeleton with heartbeat"
```

---

## Task 6: Eligibility logic

**Files:**
- Modify: `server/src/services/nightly-scrape-scheduler.ts`

- [ ] **Step 1: Add `findNextEligibleCombo`**

Append to `nightly-scrape-scheduler.ts`:

```typescript
import { getSupabase } from '../lib/supabase.js';
import { COUNTRIES, CATEGORIES } from './scrape-targets.js';

interface Combo {
  country: string;
  category: string;
}

/**
 * Walks CATEGORIES then COUNTRIES (category-major) and returns the first
 * combo that is neither (a) currently running nor (b) successfully scraped
 * within `rescrape_days`. Returns null when nothing is eligible.
 *
 * `excludeKeys` lets the caller skip combos already chosen earlier in
 * the same tick (when filling multiple parallelism slots in one tick).
 */
export async function findNextEligibleCombo(
  rescrapeDays: number,
  excludeKeys: Set<string> = new Set(),
): Promise<Combo | null> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - rescrapeDays * 86400_000).toISOString();

  // One query: every running job + every recent successful job. Cheap.
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('country, category, status, completed_at')
    .or(`status.eq.running,and(status.eq.completed,completed_at.gte.${cutoff})`);
  if (error) {
    console.error(`${LOG_PREFIX} eligibility query error:`, error.message);
    return null;
  }

  const ineligible = new Set<string>();
  for (const row of data ?? []) {
    ineligible.add(`${row.country}::${row.category}`);
  }

  for (const category of CATEGORIES) {
    for (const country of COUNTRIES) {
      const key = `${country}::${category}`;
      if (ineligible.has(key)) continue;
      if (excludeKeys.has(key)) continue;
      return { country, category };
    }
  }
  return null;
}
```

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/nightly-scrape-scheduler.ts
git commit -m "feat(scraper): add eligibility lookup for nightly combos"
```

---

## Task 7: Dequeue and spawn

**Files:**
- Modify: `server/src/services/nightly-scrape-scheduler.ts`

- [ ] **Step 1: Add spawn logic and wire into tick**

In `nightly-scrape-scheduler.ts`, add:

```typescript
import { createJob } from '../db/scrape-jobs.js';
import { runScrapeJob } from './scrape-runner.js';

async function countInflightNightlyJobs(): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('scrape_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'nightly')
    .eq('status', 'running');
  if (error) {
    console.error(`${LOG_PREFIX} inflight count error:`, error.message);
    return Number.POSITIVE_INFINITY;  // Fail closed: skip dequeue this tick
  }
  return count ?? 0;
}

async function dequeueAndSpawn(parallelism: number, rescrapeDays: number,
  minRating: number, maxRating: number, verify: boolean,
): Promise<void> {
  const inflight = await countInflightNightlyJobs();
  const slots = Math.max(0, parallelism - inflight);
  if (slots === 0) return;

  const chosenThisTick = new Set<string>();
  for (let i = 0; i < slots; i++) {
    const combo = await findNextEligibleCombo(rescrapeDays, chosenThisTick);
    if (!combo) break;

    chosenThisTick.add(`${combo.country}::${combo.category}`);

    try {
      const job = await createJob({
        country: combo.country,
        category: combo.category,
        min_rating: minRating,
        max_rating: maxRating,
        enrich: false,
        verify,
        source: 'nightly',
      });

      console.log(`${LOG_PREFIX} spawn ${combo.country}/${combo.category} job=${job.id}`);

      // Fire-and-forget — runScrapeJob writes status updates itself.
      runScrapeJob({
        jobId: job.id,
        country: combo.country,
        category: combo.category,
        minRating,
        maxRating,
        enrich: false,
        verify,
        forceRescrape: false,
        source: 'nightly',
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} spawn error for ${combo.country}/${combo.category}:`,
        err instanceof Error ? err.message : err);
    }
  }
}
```

Then replace the last line of `tick()` (the `console.log('tick OK ...')` placeholder) with:

```typescript
  await dequeueAndSpawn(
    settings.nightly_scrape_parallelism,
    settings.nightly_scrape_rescrape_days,
    settings.nightly_scrape_min_rating,
    settings.nightly_scrape_max_rating,
    settings.nightly_scrape_verify,
  );
```

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/nightly-scrape-scheduler.ts
git commit -m "feat(scraper): nightly scheduler dequeue and spawn"
```

---

## Task 8: 30-minute wall-clock cap on stuck jobs

**Files:**
- Modify: `server/src/services/nightly-scrape-scheduler.ts`

- [ ] **Step 1: Add cap-cancel logic**

Import `cancelScrapeJob`:

```typescript
import { cancelScrapeJob } from './scrape-runner.js';
```

Add the function:

```typescript
const MAX_JOB_DURATION_MS = 30 * 60 * 1000;

/**
 * Cancel any source='nightly' job that has been in status='running' for
 * over 30 minutes. The per-subprocess heartbeat already catches dead
 * processes within ~60s; this is the wall-clock ceiling for live-but-stuck
 * jobs (e.g., Playwright wedged on a captcha challenge that takes forever
 * to time out). Frees parallelism slots so the night keeps moving.
 */
async function cancelStuckNightlyJobs(): Promise<void> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - MAX_JOB_DURATION_MS).toISOString();

  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('id, country, category, started_at')
    .eq('source', 'nightly')
    .eq('status', 'running')
    .lt('started_at', cutoff);

  if (error) {
    console.error(`${LOG_PREFIX} stuck-job query error:`, error.message);
    return;
  }

  for (const job of data ?? []) {
    console.warn(`${LOG_PREFIX} wall-clock cap: cancelling stuck job ${job.id} ` +
      `(${job.country}/${job.category}, started ${job.started_at})`);
    try {
      await cancelScrapeJob(job.id);
    } catch (err) {
      console.error(`${LOG_PREFIX} cancel error for ${job.id}:`,
        err instanceof Error ? err.message : err);
    }
  }
}
```

In `tick()`, call it right after the heartbeat and before the enabled check:

```typescript
async function tick(): Promise<void> {
  await writeSchedulerTick();
  await cancelStuckNightlyJobs();  // <-- new

  const settings = await getSettings();
  // ... rest unchanged
}
```

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/nightly-scrape-scheduler.ts
git commit -m "feat(scraper): 30-minute wall-clock cap on stuck nightly jobs"
```

---

## Task 9: 3-consecutive-failure auto-pause

**Files:**
- Modify: `server/src/services/nightly-scrape-scheduler.ts`

- [ ] **Step 1: Add auto-pause check**

```typescript
/**
 * If the 3 most recent COMPLETED (success or failed) nightly jobs are all
 * status='failed', auto-pause the scheduler. Trips when Trustpilot blocks
 * the Cloud Run IP, a category-wide outage occurs, or a deploy regression
 * breaks the scrape pipeline. Manual re-enable is required so the operator
 * must intentionally clear the pause.
 */
async function autoPauseIfFailing(): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('status')
    .eq('source', 'nightly')
    .in('status', ['completed', 'failed'])
    .order('completed_at', { ascending: false })
    .limit(3);

  if (error) {
    console.error(`${LOG_PREFIX} auto-pause query error:`, error.message);
    return false;
  }

  if ((data?.length ?? 0) < 3) return false;
  const allFailed = data!.every((j) => j.status === 'failed');
  if (!allFailed) return false;

  const reason = `auto: 3 consecutive failed nightly jobs (last at ${new Date().toISOString()})`;
  console.error(`${LOG_PREFIX} AUTO-PAUSE: ${reason}`);
  await setPausedReason(reason);
  await updateSettings({ nightly_scrape_enabled: false });
  return true;
}
```

In `tick()`, call this AFTER cap-cancel and BEFORE the dequeue. If it returns true, skip dequeue this tick:

```typescript
async function tick(): Promise<void> {
  await writeSchedulerTick();
  await cancelStuckNightlyJobs();

  if (await autoPauseIfFailing()) return;

  const settings = await getSettings();
  // ... rest unchanged
}
```

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/nightly-scrape-scheduler.ts
git commit -m "feat(scraper): auto-pause after 3 consecutive failed nightly jobs"
```

---

## Task 10: Routes and run-now / stop endpoints

**Files:**
- Create: `server/src/routes/scrape-schedule.ts`
- Modify: `server/src/server.ts` (add route mount)

- [ ] **Step 1: Write the routes**

`server/src/routes/scrape-schedule.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { getSettings, updateSettings, type AppSettings } from '../db/app-settings.js';
import { setRunNowOverride, isRunNowActive } from '../services/nightly-scrape-scheduler.js';
import { cancelScrapeJob } from '../services/scrape-runner.js';
import { getSupabase } from '../lib/supabase.js';
import { COUNTRIES, CATEGORIES } from '../services/scrape-targets.js';

const router = Router();

// Settings fields the client is allowed to mutate via PATCH.
// Excludes server-managed fields (last_tick_at, paused_reason, updated_at).
const MUTABLE_FIELDS: Array<keyof AppSettings> = [
  'nightly_scrape_enabled',
  'nightly_scrape_start_hour',
  'nightly_scrape_end_hour',
  'nightly_scrape_timezone',
  'nightly_scrape_rescrape_days',
  'nightly_scrape_parallelism',
  'nightly_scrape_verify',
  'nightly_scrape_min_rating',
  'nightly_scrape_max_rating',
  'nightly_scheduler_paused_reason',  // allow client to clear the pause to null
];

router.get('/', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const settings = await getSettings();

    const { data: inflight } = await supabase
      .from('scrape_jobs')
      .select('id, country, category, status, started_at, total_found')
      .eq('source', 'nightly')
      .eq('status', 'running')
      .order('started_at', { ascending: true });

    const { data: recentJobs } = await supabase
      .from('scrape_jobs')
      .select('id, country, category, status, started_at, completed_at, total_found, total_failed')
      .eq('source', 'nightly')
      .order('created_at', { ascending: false })
      .limit(20);

    res.json({
      success: true,
      data: {
        settings,
        status: {
          phase: derivePhase(settings, inflight ?? []),
          inflight: inflight ?? [],
          runNowActive: isRunNowActive(),
          matrixSize: COUNTRIES.length * CATEGORIES.length,
        },
        recentJobs: recentJobs ?? [],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.patch('/', async (req: Request, res: Response) => {
  try {
    const patch: Partial<AppSettings> = {};
    for (const key of MUTABLE_FIELDS) {
      if (key in req.body) (patch as Record<string, unknown>)[key] = req.body[key];
    }
    const settings = await updateSettings(patch);
    res.json({ success: true, data: { settings } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/run-now', async (_req: Request, res: Response) => {
  try {
    const until = setRunNowOverride();
    res.json({ success: true, data: { runNowUntil: new Date(until).toISOString() } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/stop', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: inflight } = await supabase
      .from('scrape_jobs')
      .select('id')
      .eq('source', 'nightly')
      .eq('status', 'running');

    let cancelled = 0;
    for (const job of inflight ?? []) {
      try {
        await cancelScrapeJob(job.id);
        cancelled++;
      } catch {
        // best-effort: log and keep going. Orphan reaper will catch stragglers.
      }
    }
    await updateSettings({ nightly_scrape_enabled: false });
    res.json({ success: true, data: { cancelled } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

function derivePhase(
  s: AppSettings,
  inflight: Array<{ id: string }>,
): 'disabled' | 'paused' | 'waiting_for_window' | 'inside_window_idle' | 'inside_window_running' | 'override_running' {
  if (s.nightly_scheduler_paused_reason) return 'paused';
  if (isRunNowActive()) return inflight.length > 0 ? 'override_running' : 'inside_window_idle';
  if (!s.nightly_scrape_enabled) return 'disabled';

  const hour = (() => {
    try {
      return Number(new Intl.DateTimeFormat('en-US', {
        timeZone: s.nightly_scrape_timezone, hour: 'numeric', hour12: false,
      }).format(new Date()));
    } catch { return new Date().getUTCHours(); }
  })();

  const inWindow = s.nightly_scrape_start_hour === s.nightly_scrape_end_hour
    ? false
    : s.nightly_scrape_start_hour < s.nightly_scrape_end_hour
      ? hour >= s.nightly_scrape_start_hour && hour < s.nightly_scrape_end_hour
      : hour >= s.nightly_scrape_start_hour || hour < s.nightly_scrape_end_hour;

  if (!inWindow) return 'waiting_for_window';
  return inflight.length > 0 ? 'inside_window_running' : 'inside_window_idle';
}

export default router;
```

- [ ] **Step 2: Mount in server.ts**

In `server/src/server.ts`, add the import near the other route imports (around line 23):

```typescript
import scrapeScheduleRoutes from './routes/scrape-schedule.js';
```

Then mount it (after the existing `app.use('/api/scrape', scrapeRoutes);` line around line 50):

```typescript
app.use('/api/scrape/schedule', scrapeScheduleRoutes);
```

Important: the schedule route MUST be mounted on its own path (not nested into `scrapeRoutes`) because the existing scrape router has a `DELETE /:id` that would swallow `schedule` as an `id`. Mounting separately at `/api/scrape/schedule` avoids the collision since Express matches longer paths first.

- [ ] **Step 3: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/scrape-schedule.ts server/src/server.ts
git commit -m "feat(api): add /api/scrape/schedule routes"
```

---

## Task 11: Start the scheduler on server boot

**Files:**
- Modify: `server/src/server.ts` (add startup call near the other scheduler starts around lines 175-190)

- [ ] **Step 1: Register scheduler startup**

In `server/src/server.ts`, find the existing block that calls `startCampaignScheduler()` (around line 184). Right after the closing `}` of that try/catch, add:

```typescript
  // Start nightly scrape scheduler — DB-driven poller that runs the full
  // country x category matrix overnight inside the configured window.
  try {
    const { startNightlyScrapeScheduler } = await import('./services/nightly-scrape-scheduler.js');
    startNightlyScrapeScheduler();
  } catch (e) {
    console.error('[Startup] Nightly scrape scheduler error:', e instanceof Error ? e.message : e);
  }
```

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Local smoke test**

Run: `cd server && npm run dev`
Expected stdout to include: `[NightlyScheduler] Started — polling every 60s`.

Stop the server with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(scraper): start nightly scheduler on server boot"
```

---

## Task 12: Frontend — add Finance categories to manual scrape form

**Files:**
- Modify: `frontend/src/components/ScrapeForm.tsx` (line 38, end of CATEGORIES array)

- [ ] **Step 1: Append Finance categories**

In `frontend/src/components/ScrapeForm.tsx`, find the closing `];` of the CATEGORIES array (line 38) and replace lines 35-38 with:

```typescript
  'video_game_store',              // Video Game Store
  'game_store',                    // Game Store
  // ── Finance ──────────────────────────────────────────────────
  'money_insurance',               // Money & Insurance (parent)
  'investing_wealth',              // Investing & Wealth
  'investment_service',            // Investment Service
];
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ScrapeForm.tsx
git commit -m "feat(frontend): add Money & Insurance categories to scrape form"
```

---

## Task 13: Frontend — schedule API hook

**Files:**
- Create: `frontend/src/hooks/useSchedule.ts`

- [ ] **Step 1: Write the hook**

```typescript
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/client';

export interface ScheduleSettings {
  nightly_scrape_enabled: boolean;
  nightly_scrape_start_hour: number;
  nightly_scrape_end_hour: number;
  nightly_scrape_timezone: string;
  nightly_scrape_rescrape_days: number;
  nightly_scrape_parallelism: number;
  nightly_scrape_verify: boolean;
  nightly_scrape_min_rating: number;
  nightly_scrape_max_rating: number;
  nightly_scheduler_last_tick_at: string | null;
  nightly_scheduler_paused_reason: string | null;
}

export interface InflightJob {
  id: string;
  country: string;
  category: string;
  status: string;
  started_at: string;
  total_found: number | null;
}

export interface RecentJob extends InflightJob {
  completed_at: string | null;
  total_failed: number | null;
}

export type SchedulePhase =
  | 'disabled' | 'paused' | 'waiting_for_window'
  | 'inside_window_idle' | 'inside_window_running' | 'override_running';

export interface ScheduleResponse {
  settings: ScheduleSettings;
  status: {
    phase: SchedulePhase;
    inflight: InflightJob[];
    runNowActive: boolean;
    matrixSize: number;
  };
  recentJobs: RecentJob[];
}

const POLL_INTERVAL_MS = 10_000;

export function useSchedule() {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);

  const fetchSchedule = useCallback(async () => {
    try {
      const { data: res } = await api.get('/scrape/schedule');
      if (mounted.current) setData(res.data);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    fetchSchedule();
    const iv = setInterval(fetchSchedule, POLL_INTERVAL_MS);
    return () => { mounted.current = false; clearInterval(iv); };
  }, [fetchSchedule]);

  const saveSettings = useCallback(async (patch: Partial<ScheduleSettings>) => {
    setSaving(true);
    try {
      const { data: res } = await api.patch('/scrape/schedule', patch);
      setData((prev) => prev ? { ...prev, settings: res.data.settings } : prev);
      await fetchSchedule();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [fetchSchedule]);

  const runNow = useCallback(async () => {
    await api.post('/scrape/schedule/run-now');
    await fetchSchedule();
  }, [fetchSchedule]);

  const stop = useCallback(async () => {
    await api.post('/scrape/schedule/stop');
    await fetchSchedule();
  }, [fetchSchedule]);

  const clearPause = useCallback(async () => {
    await saveSettings({ nightly_scheduler_paused_reason: null });
  }, [saveSettings]);

  return { data, error, saving, saveSettings, runNow, stop, clearPause, refresh: fetchSchedule };
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useSchedule.ts
git commit -m "feat(frontend): add useSchedule hook for nightly scheduler API"
```

---

## Task 14: Frontend — NightlyScheduleCard component

**Files:**
- Create: `frontend/src/components/NightlyScheduleCard.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useState, useEffect } from 'react';
import { Play, Square, RotateCcw, AlertTriangle } from 'lucide-react';
import { useSchedule, type ScheduleSettings, type SchedulePhase } from '../hooks/useSchedule';

const TIMEZONES = [
  'Asia/Manila', 'Asia/Singapore', 'Asia/Hong_Kong',
  'America/New_York', 'America/Los_Angeles',
  'Europe/London', 'Europe/Berlin', 'UTC',
];

const PHASE_LABEL: Record<SchedulePhase, string> = {
  disabled: 'Disabled',
  paused: 'Auto-paused',
  waiting_for_window: 'Waiting for window',
  inside_window_idle: 'Idle — no eligible combos',
  inside_window_running: 'Running',
  override_running: 'Run now active',
};

const PHASE_COLOR: Record<SchedulePhase, string> = {
  disabled: 'bg-surface-container text-secondary',
  paused: 'bg-red-100 text-red-800',
  waiting_for_window: 'bg-amber-100 text-amber-800',
  inside_window_idle: 'bg-blue-100 text-blue-800',
  inside_window_running: 'bg-[#ffd9de] text-[#b0004a]',
  override_running: 'bg-[#ffd9de] text-[#b0004a]',
};

export default function NightlyScheduleCard() {
  const { data, error, saving, saveSettings, runNow, stop, clearPause } = useSchedule();
  const [draft, setDraft] = useState<ScheduleSettings | null>(null);

  // Reset local draft when server data lands.
  useEffect(() => {
    if (data?.settings && !draft) setDraft(data.settings);
  }, [data?.settings, draft]);

  if (error) {
    return <div className="bg-red-50 text-red-800 rounded-xl p-4">Schedule API error: {error}</div>;
  }
  if (!data || !draft) {
    return <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6 text-secondary">Loading schedule…</div>;
  }

  const { settings, status, recentJobs } = data;
  const tickAgeSec = settings.nightly_scheduler_last_tick_at
    ? Math.round((Date.now() - new Date(settings.nightly_scheduler_last_tick_at).getTime()) / 1000)
    : null;
  const tickStale = tickAgeSec !== null && tickAgeSec > 120;

  const onToggle = async (next: boolean) => {
    await saveSettings({ nightly_scrape_enabled: next });
  };

  const onSaveDraft = async () => {
    await saveSettings({
      nightly_scrape_start_hour: draft.nightly_scrape_start_hour,
      nightly_scrape_end_hour: draft.nightly_scrape_end_hour,
      nightly_scrape_timezone: draft.nightly_scrape_timezone,
      nightly_scrape_rescrape_days: draft.nightly_scrape_rescrape_days,
      nightly_scrape_parallelism: draft.nightly_scrape_parallelism,
      nightly_scrape_verify: draft.nightly_scrape_verify,
      nightly_scrape_min_rating: draft.nightly_scrape_min_rating,
      nightly_scrape_max_rating: draft.nightly_scrape_max_rating,
    });
  };

  return (
    <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-4 sm:p-6 xl:p-8">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Nightly Schedule
        </h3>
        <span className={`flex items-center gap-2 text-xs font-bold px-3 py-1.5 rounded-full ${PHASE_COLOR[status.phase]}`}>
          {status.phase === 'inside_window_running' || status.phase === 'override_running' ? (
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse inline-block" />
          ) : null}
          {PHASE_LABEL[status.phase]}
          {status.phase === 'inside_window_running' || status.phase === 'override_running'
            ? ` ${status.inflight.length}/${status.matrixSize}`
            : ''}
        </span>
      </div>

      {settings.nightly_scheduler_paused_reason && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-red-800 flex-1">
            <div className="font-semibold">Scheduler auto-paused</div>
            <div className="text-xs opacity-90 mt-0.5">{settings.nightly_scheduler_paused_reason}</div>
          </div>
          <button onClick={clearPause} className="text-xs font-bold text-red-800 underline">Clear & resume</button>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.nightly_scrape_enabled}
            onChange={(e) => onToggle(e.target.checked)}
            disabled={saving || !!settings.nightly_scheduler_paused_reason}
          />
          <span className="font-bold">Enable nightly schedule</span>
        </label>
        <span className={`text-xs ${tickStale ? 'text-red-600' : 'text-secondary'}`}>
          Last tick: {tickAgeSec === null ? 'never' : `${tickAgeSec}s ago`}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4 text-sm">
        <label className="flex flex-col">
          <span className="text-xs text-secondary mb-1">Start hour</span>
          <input type="number" min={0} max={23} className="border rounded px-2 py-1"
            value={draft.nightly_scrape_start_hour}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_start_hour: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-secondary mb-1">End hour</span>
          <input type="number" min={0} max={23} className="border rounded px-2 py-1"
            value={draft.nightly_scrape_end_hour}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_end_hour: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-secondary mb-1">Timezone</span>
          <select className="border rounded px-2 py-1"
            value={draft.nightly_scrape_timezone}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_timezone: e.target.value })}>
            {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-secondary mb-1">Rescrape every (days)</span>
          <input type="number" min={1} max={90} className="border rounded px-2 py-1"
            value={draft.nightly_scrape_rescrape_days}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_rescrape_days: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-secondary mb-1">Parallelism</span>
          <input type="number" min={1} max={5} className="border rounded px-2 py-1"
            value={draft.nightly_scrape_parallelism}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_parallelism: Number(e.target.value) })} />
        </label>
        <label className="flex items-center gap-2 mt-5">
          <input type="checkbox"
            checked={draft.nightly_scrape_verify}
            onChange={(e) => setDraft({ ...draft, nightly_scrape_verify: e.target.checked })} />
          <span>Verify emails</span>
        </label>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        <button onClick={onSaveDraft} disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-bold rounded">Save</button>
        <button onClick={runNow} disabled={saving}
          className="px-4 py-2 bg-[#b0004a] text-white text-sm font-bold rounded inline-flex items-center gap-1.5">
          <Play className="w-3.5 h-3.5" /> Run now (4h)
        </button>
        <button onClick={stop} disabled={saving}
          className="px-4 py-2 bg-surface-container text-on-surface text-sm font-bold rounded inline-flex items-center gap-1.5">
          <Square className="w-3.5 h-3.5" /> Stop in-flight
        </button>
      </div>

      <div className="border-t pt-4">
        <h4 className="text-sm font-bold mb-2 text-on-surface">Tonight's activity</h4>
        {recentJobs.length === 0 ? (
          <div className="text-xs text-secondary">No nightly runs yet.</div>
        ) : (
          <ul className="space-y-1 text-xs font-mono">
            {recentJobs.map((j) => (
              <li key={j.id} className="flex items-center gap-2">
                <span className={
                  j.status === 'completed' ? 'text-emerald-700'
                  : j.status === 'failed' ? 'text-red-700'
                  : j.status === 'running' ? 'text-blue-700' : 'text-secondary'
                }>
                  {j.status === 'completed' ? '✓' : j.status === 'failed' ? '✗' : j.status === 'running' ? '◷' : '·'}
                </span>
                <span>{j.category} · {j.country}</span>
                <span className="text-secondary">·</span>
                <span>{j.total_found ?? 0} leads</span>
                <span className="text-secondary">·</span>
                <span className="text-secondary">
                  {j.completed_at ? new Date(j.completed_at).toLocaleTimeString() : 'running'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/NightlyScheduleCard.tsx
git commit -m "feat(frontend): add NightlyScheduleCard component"
```

---

## Task 15: Wire the card into the Scrape page

**Files:**
- Modify: `frontend/src/views/Scrape.tsx` (line ~83, after the main grid div closes)

- [ ] **Step 1: Add the import**

Near the top of `frontend/src/views/Scrape.tsx` add:

```typescript
import NightlyScheduleCard from '../components/NightlyScheduleCard';
```

- [ ] **Step 2: Render the card below the existing config card**

Find the closing `</div>` of the "Scrape Config" col-span-8 wrapper (after the existing `<ScrapeForm ... />`, around line 80). Right after that closing div for the scrape config card, before the next sibling, add:

```tsx
        {/* Nightly Schedule */}
        <div className="col-span-12 xl:col-span-8">
          <NightlyScheduleCard />
        </div>
```

The xl:col-span-8 keeps it aligned with the scrape form on wide screens; the existing right-column stats cards stay where they are.

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Local smoke test**

Run two terminals:

```bash
cd server && npm run dev
```

```bash
cd frontend && npm run dev
```

Open http://localhost:5173 → Scrape page. Expect:
- Existing "Scrape Trustpilot" card unchanged.
- New "Nightly Schedule" card below it with status badge "Disabled", default settings shown, and an empty "Tonight's activity" section.
- Last tick: updates from "never" to "Xs ago" within 60s.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/Scrape.tsx
git commit -m "feat(frontend): render NightlyScheduleCard on Scrape page"
```

---

## Task 16: End-to-end smoke test via Run now

The server and migration are now fully wired. This task verifies the full path: API → DB → scheduler tick → spawn → runScrapeJob → completion → UI update.

- [ ] **Step 1: Verify scheduler is alive (no scrape yet)**

With both dev servers running (Task 15 Step 4), open the Scrape page. Confirm:
- "Last tick: <60s ago" updates in real time.
- Status badge = "Disabled".

If "Last tick: never" persists past 90s, the scheduler didn't start. Check server stdout for `[NightlyScheduler] Started`.

- [ ] **Step 2: Trigger a one-combo Run now (parallelism=1)**

In the schedule card:
1. Change "Parallelism" to `1`. Click Save.
2. Click "Run now (4h)".

Within 60s, expect server logs:
```
[NightlyScheduler] spawn AU/gambling job=<uuid>
```

The status badge should switch to `Run now active 1/352` and "Tonight's activity" should show one `◷ gambling · AU · 0 leads · running` row.

- [ ] **Step 3: Watch it complete**

The Trustpilot scrape for the first combo typically takes 3-5 minutes. When done:
- "Tonight's activity" row updates to `✓ gambling · AU · N leads · HH:MM:SS` (or `✗` if failed).
- Status returns to `Run now active — Idle` since parallelism=1 and we already used the slot.

Then the scheduler picks the next eligible combo (`gambling/AT`) on its next tick.

- [ ] **Step 4: Stop and verify cleanup**

Click "Stop in-flight". Expect:
- Settings: `nightly_scrape_enabled=false` (toggle visibly off).
- Any running nightly job is cancelled (orphan reaper finalizes within 60s if not immediate).
- Status badge → `Disabled`.

- [ ] **Step 5: (No commit — this task is verification only)**

If all four steps passed, the feature works locally. Proceed to deployment.

---

## Task 17: Deploy

- [ ] **Step 1: Push frontend (Vercel auto-deploys)**

```bash
git push origin main
```

- [ ] **Step 2: Deploy backend to Cloud Run**

Show the user these commands (do not run automatically — project policy):

```powershell
powershell -ExecutionPolicy Bypass -Command "cd 'c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH'; gcloud run deploy trustpilot-crm --source . --region us-central1 --project=trustpilot-leadgen --quiet"
```

- [ ] **Step 3: Verify deployment**

After the gcloud command finishes:

```bash
gcloud run revisions list --service=trustpilot-crm --region=us-central1 --project=trustpilot-leadgen --limit=3
```

Confirm the new revision is `Ready=True` with 100% traffic.

```bash
gcloud run services logs read trustpilot-crm --region=us-central1 --project=trustpilot-leadgen --limit=50 | grep NightlyScheduler
```

Expect at least one `[NightlyScheduler] Started — polling every 60s` line.

- [ ] **Step 4: Hit the live endpoint to confirm routing**

```bash
curl -H "x-api-key: $API_SECRET_KEY" https://<gateway-host>/api/scrape/schedule
```

Expect a JSON response with `data.settings.nightly_scrape_timezone === "Asia/Manila"`.

- [ ] **Step 5: Production smoke test**

Open the live frontend → Scrape page. Repeat the Run-now-and-watch-one-combo flow from Task 16 Step 2. If it works in prod, the feature is ready.

---

## Acceptance criteria (mirror of spec)

After all tasks complete:

1. ✅ `app_settings` row exists with `nightly_scrape_timezone='Asia/Manila'`, `start_hour=0`, `end_hour=14`.
2. ✅ `scrape_jobs.source` column exists; all existing rows default to `'manual'`.
3. ✅ Scheduler heartbeat updates `nightly_scheduler_last_tick_at` every ~60s.
4. ✅ With `nightly_scrape_enabled=false`, no `source='nightly'` rows are created.
5. ✅ With `nightly_scrape_enabled=true` inside the window, eligible combos are dequeued category-major.
6. ✅ Parallelism cap is enforced — never more than N nightly jobs in `status='running'` at once.
7. ✅ Cutoff at `end_hour` stops new dequeues; in-flight nightly jobs run to completion.
8. ✅ Combos with a successful job inside `rescrape_days` are skipped.
9. ✅ `POST /api/scrape/schedule/run-now` activates a 4-hour override bypassing the time window.
10. ✅ `POST /api/scrape/schedule/stop` cancels in-flight nightly jobs and disables the schedule.
11. ✅ Three new Finance categories appear in the manual scrape form AND the nightly cycle.
12. ✅ NightlyScheduleCard renders on the Scrape page with live status + activity feed.
13. ✅ 30-min wall-clock cap force-cancels stuck nightly jobs.
14. ✅ 3 consecutive failed-with-zero-leads nightly jobs auto-pause the scheduler and surface a banner.

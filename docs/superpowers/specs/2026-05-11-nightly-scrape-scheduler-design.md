# Nightly Scrape Scheduler — Design

**Status:** draft (2026-05-11)
**Owner:** john@optinetsolutions.com

---

## Problem

Today, scraping is fully manual: the user picks one (country, category) at a time from the Scrape page and waits for it to finish. Covering the full matrix of 16 countries × 22 categories = 352 combos takes ~24 hours of human-supervised clicking. The user wants leads ready to send in the morning without staying awake to babysit jobs.

## Goal

Add a one-click "Enable nightly schedule" toggle. When on, the server automatically scrapes every country×category combo, category-major, inside a configurable daily window (default 00:00–14:00 Asia/Manila), respecting a "skip if scraped in last N days" rule. The user goes to sleep, leads are ready by the time the email day starts.

## Non-goals

- No 336-row combo state table. Eligibility is computed at runtime from existing `scrape_jobs` history.
- No per-combo enable/disable UI. The static category and country lists are the source of truth; turn the whole scheduler off if you don't want it to run.
- No external Cloud Scheduler / cron infrastructure. An in-process daemon matches every other scheduler in this repo (`campaign-scheduler`, `warmup-scheduler`, `sequence-scheduler`, `reply-tracker`).
- No enrichment in the nightly run (`enrich=false`). Verification only.
- No batch-run history table. The `scrape_jobs` table tagged with `source='nightly'` is enough to power the activity feed.
- No retry counter. Failed combos become eligible again after `rescrape_days` and try once per cycle.
- No mid-scrape cancellation at the cutoff. When 14:00 hits, the scheduler stops dequeuing *new* combos but lets in-flight jobs finish.

---

## Architecture

One new in-process daemon, one new settings row, two new constants files, four new API routes, one frontend panel. Reuses the existing `runScrapeJob()` plumbing — no scraper changes.

```
┌──────────────────────────────────────────────┐
│  Scrape page (frontend)                      │
│  ┌────────────────────────────────────────┐  │
│  │ NightlyScheduleCard                    │  │
│  │  - master toggle                       │  │
│  │  - time window + TZ                    │  │
│  │  - rescrape days, parallelism, verify  │  │
│  │  - Run now / Stop                      │  │
│  │  - Tonight's activity feed             │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────┬───────────────────┘
                           │ /api/scrape/schedule
                           ▼
┌──────────────────────────────────────────────┐
│  Express                                     │
│  - GET/PATCH /api/scrape/schedule            │
│  - POST /api/scrape/schedule/run-now         │
│  - POST /api/scrape/schedule/stop            │
└──────────────────────────┬───────────────────┘
                           │ reads/writes
                           ▼
┌──────────────────────────────────────────────┐
│  Supabase                                    │
│  - app_settings (new, 1 row)                 │
│  - scrape_jobs (gains `source` column)       │
└──────────────────────────▲───────────────────┘
                           │
┌──────────────────────────┴───────────────────┐
│  nightly-scrape-scheduler.ts (new, 60s tick) │
│  - inside-window?                            │
│  - parallelism cap?                          │
│  - dequeue next eligible combo               │
│  - spawn runScrapeJob(source='nightly')      │
└──────────────────────────────────────────────┘
```

---

## Data model

### New: `app_settings` (single row, id=1 only)

| Column                          | Type        | Default          | Notes                              |
| ------------------------------- | ----------- | ---------------- | ---------------------------------- |
| `id`                            | int PK      | `1` (CHECK = 1)  | enforces single-row semantics      |
| `nightly_scrape_enabled`        | bool        | `false`          | master toggle                      |
| `nightly_scrape_start_hour`     | int (0–23)  | `0`              | local-time hour, inclusive         |
| `nightly_scrape_end_hour`       | int (0–23)  | `14`             | local-time hour, exclusive         |
| `nightly_scrape_timezone`       | text        | `'Asia/Manila'`  | IANA tz id                         |
| `nightly_scrape_rescrape_days`  | int         | `7`              | skip combos scraped within N days  |
| `nightly_scrape_parallelism`    | int         | `2`              | max concurrent nightly jobs        |
| `nightly_scrape_verify`         | bool        | `true`           | passes `verify=true` to runScrapeJob |
| `nightly_scrape_min_rating`     | real        | `1.0`            |                                    |
| `nightly_scrape_max_rating`     | real        | `3.5`            |                                    |
| `nightly_scheduler_last_tick_at`| timestamptz | `null`           | written every tick; powers liveness UI |
| `nightly_scheduler_paused_reason` | text      | `null`           | non-null = auto-paused; surfaced in UI banner |
| `updated_at`                    | timestamptz | `now()`          |                                    |

### Modified: `scrape_jobs`

Add column `source text NOT NULL DEFAULT 'manual'`. Set to `'nightly'` for scheduler-spawned jobs. Used to (a) count in-flight nightly jobs for parallelism, (b) power the "Tonight's activity" feed.

Add index `(source, status, completed_at DESC)` for the parallelism and dedup queries.

### New backend constants: `server/src/services/scrape-targets.ts`

Mirrors `COUNTRIES` and `CATEGORIES` from `frontend/src/components/ScrapeForm.tsx`. Adds the new Finance section.

```ts
export const COUNTRIES = ['AU','AT','BR','CA','DK','FI','FR','DE','IT','NL','NO','ES','SE','AE','GB','US']; // 16

export const CATEGORIES = [
  // Gambling
  'gambling','casino','online_casino_or_bookmaker','online_sports_betting',
  'betting_agency','bookmaker','gambling_service','gambling_house',
  'off_track_betting_shop','lottery_vendor','online_lottery_ticket_vendor',
  'lottery_retailer','lottery_shop','gambling_instructor',
  // Gaming
  'gaming','gaming_service_provider','bingo_hall','video_game_store','game_store',
  // Finance (new)
  'money_insurance','investing_wealth','investment_service',
]; // 22
```

The matching frontend constant is updated in the same change so the manual Scrape form gets the new Finance options too.

Slug note: `investing_wealth` is Trustpilot's canonical slug for "Investing & Wealth" (not `investment_and_wealth`). If the first nightly run yields 0 leads across all 16 countries for any of these three, that's the signal the slug is wrong and needs adjusting in this file.

---

## Components

### 1. `server/src/services/nightly-scrape-scheduler.ts` (new)

`startNightlyScrapeScheduler()` is called from `server.ts` startup, after the existing schedulers. It sets a 60-second `setInterval` and runs a tick function.

#### Tick logic

```
1. Load app_settings.
2. If nightly_scrape_enabled = false AND no in-memory "run now" override active → idle, return.
3. Compute current hour in settings.timezone using Intl.DateTimeFormat.
4. If outside [start_hour, end_hour] AND no "run now" override → idle, return.
5. Count in-flight scrape_jobs where source='nightly' AND status='running'. Call this `inflight`.
6. `slotsOpen = max(0, parallelism - inflight)`. If 0 → return.
7. For each open slot, compute next eligible combo (see dequeue logic). If null → break.
   Spawn it via runScrapeJob({ country, category, minRating, maxRating, enrich=false,
   verify=settings.verify, source:'nightly' }). Pre-insert findActiveJobForParams dedup is
   bypassed since the eligibility check already handles it.
8. Return. Next tick (60s) reconsiders.
```

Spawning multiple jobs in a single tick avoids the cold-start ramp where each tick adds only one job. With parallelism=2 and an empty pipeline, the first tick fills both slots immediately.

#### Dequeue logic (next eligible combo)

```
for category in CATEGORIES (array order):
  for country in COUNTRIES (array order):
    if exists scrape_jobs row where (country, category) AND status='running':
      continue  // someone is already scraping this combo (could be manual)

    last_success = max(completed_at) from scrape_jobs
                   where country=? AND category=? AND status='completed'
                   AND completed_at > now() - rescrape_days

    if last_success exists:
      continue  // freshly scraped, skip

    return { country, category }   // first eligible combo wins

return null  // nothing eligible this cycle
```

A single query with `DISTINCT ON (country, category)` over `scrape_jobs` returns the most recent success per combo; the scheduler joins that against the static matrix in memory. Cheap: 352 rows max.

#### "Run now" override

An in-memory flag (`runNowUntil: number | null`, epoch ms). Set to `Date.now() + 4*3600*1000` (4 hours) by the run-now endpoint. The tick treats `runNowUntil > Date.now()` as a green light that bypasses both the `nightly_scrape_enabled=false` check (step 2) and the time-window check (step 4). Parallelism and dedup are still enforced.

A 4-hour TTL is enough to drain meaningful work for a manual test without risking the override silently outlasting a Cloud Run instance and confusing the next day's natural run. The flag is process-local: if the instance restarts, the override is lost. Acceptable — it's a "test outside window" convenience, not durable state.

#### Stop

`stopNightlyScheduler()` (called by `POST /stop`):
1. Sets `nightly_scrape_enabled = false`.
2. Looks up in-flight `scrape_jobs` with `source='nightly'` and `status='running'`, calls `cancelScrapeJob(id)` on each via the existing route.

Used when the user wants to halt mid-run. Distinct from the natural cutoff (which leaves in-flight jobs alone).

### 2. `server/src/db/app-settings.ts` (new)

Thin CRUD layer. `getSettings()` upserts the default `{ id: 1, ... }` row if missing, returns the row. `updateSettings(partial)` patches and returns updated row.

### 3. `server/src/routes/scrape-schedule.ts` (new), mounted at `/api/scrape/schedule`

| Route             | Method | Body                            | Returns                                                                                         |
| ----------------- | ------ | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/`               | GET    | —                               | `{ settings, status: { phase, inflight, nextCombo, nextRunCountdownMs }, recentJobs: [...20] }` |
| `/`               | PATCH  | `Partial<settings>`             | `{ settings }`                                                                                  |
| `/run-now`        | POST   | —                               | `{ runNowUntil }`                                                                               |
| `/stop`           | POST   | —                               | `{ stopped: <n> }`                                                                              |

`status.phase` ∈ `'disabled' | 'waiting_for_window' | 'inside_window_idle' | 'inside_window_running' | 'override_running'`.

`recentJobs` = last 20 `scrape_jobs` rows where `source='nightly'`, joined with lead counts.

### 4. `frontend/src/views/Scrape.tsx` + new `frontend/src/components/NightlyScheduleCard.tsx`

A new card rendered below the existing scrape config card. Layout:

```
┌─ Nightly Schedule ──────────────────────────── [● Running 4/352] ┐
│                                                                   │
│  [●━━━━━━] Enable                                                 │
│                                                                   │
│  Window:   00 : 00  →  14 : 00     TZ: [Asia/Manila ▾]            │
│  Rescrape every: [7] days                                         │
│  Parallel:       [2] jobs                                         │
│  Verify emails:  [✓]                                              │
│  Rating range:   [1.0] – [3.5]                                    │
│                                                                   │
│  [Save]  [Run now]  [Stop in-flight]                              │
│                                                                   │
│  ─ Tonight's activity ──────────────────────────────────          │
│  ✓ casino · DE · 47 leads · 02:14                                 │
│  ✓ casino · FR · 32 leads · 02:08                                 │
│  ◷ casino · GB · running · 02:21                                  │
│  ...                                                              │
└───────────────────────────────────────────────────────────────────┘
```

Status badge text driven by `status.phase`:
- `disabled` → "Disabled"
- `waiting_for_window` → "Idle until 00:00 PHT (4h 23m)"
- `inside_window_idle` → "Inside window — no eligible combos"
- `inside_window_running` → "Running 4/352"
- `override_running` → "Run now: 2 in flight"

The card polls `GET /api/scrape/schedule` every 10 seconds while mounted.

### 5. Migration: `supabase/migrations/009_nightly_scrape_schedule.sql`

```sql
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

---

## Failure handling — one failure never kills the whole night

The design is **isolation-first**: every defense below scopes failure to a single combo or a single tick. The daemon, the night, and other combos survive.

- **Combo scrape fails.** Existing `scrape_failures` capture per-URL failures; `scrape_jobs.status='failed'` is written by `scrape-runner`. The combo becomes eligible again after `rescrape_days` and gets one more shot on the next cycle. No infinite retries inside a single night.
- **Cloud Run instance restarts mid-night.** The existing orphan reaper (`scrape-orphan-reaper`, runs every 60s) marks abandoned `scrape_jobs.status='running'` rows as `failed`. The scheduler's next tick treats those combos as failed and either retries them (if they're still in window) or leaves them for next cycle.
- **Cutoff hit while a combo is still running.** Scheduler stops dequeuing new combos. In-flight jobs run to completion — they update `scrape_jobs` normally. No wasted work.
- **User clicks Stop in-flight.** Calls existing `cancelScrapeJob()` for each running nightly job. Sets `nightly_scrape_enabled=false`. Cancelled combos become eligible again after `rescrape_days` (or sooner if the user toggles back on and the `last_completed_at` was never updated).
- **DNS / Trustpilot blocks the Cloud Run IP.** Caught by the 3-consecutive-failure guard below.
- **Tick throws.** Every tick is wrapped in `try/catch`. Errors log to stderr with `[NightlyScheduler]` prefix. The `setInterval` callback never propagates, so the daemon survives any one bad tick. Same pattern campaign-scheduler uses today.
- **Settings out of range.** `getSettings()` clamps on read: `start_hour ∈ [0,23]`, `end_hour ∈ [0,23]`, `parallelism ∈ [1,5]`, `rescrape_days ∈ [1,90]`. Bad DB values can't induce infinite loops or zero-parallelism deadlocks.

### Built-in reliability defenses

These are part of the implementation, not optional polish:

1. **Tick heartbeat.** `app_settings.nightly_scheduler_last_tick_at` is written on every tick (success or no-op). The frontend polls `GET /api/scrape/schedule` and renders "last tick: 23s ago" in the schedule card. Anything over 2 minutes is the user's signal to investigate.

2. **Per-job 30-min wall-clock cap.** Before each tick's dequeue, the scheduler scans for `source='nightly'` jobs in `status='running'` with `started_at < now() - interval '30 minutes'`. Any match is force-cancelled via `cancelScrapeJob()`. Frees a parallelism slot so one wedged Playwright process can't lock up the night. The existing per-subprocess heartbeat already catches dead processes within 60s; this is a wall-clock ceiling for live-but-stuck ones.

3. **3-consecutive-failure auto-pause.** The scheduler tracks the last 3 completed `source='nightly'` jobs. If all three are `status='failed'`, set `nightly_scheduler_paused_reason = 'auto: 3 consecutive failed nightly jobs'`, set `nightly_scrape_enabled=false`, and stop dequeuing. The frontend renders a red banner on the Scrape page. Manual re-enable required — the user must intentionally clear the pause. This is the IP-block / category-wide-outage tripwire: it prevents the scheduler from burning the whole night failing the same way. (The `total_found=0` check from earlier drafts was dropped — a failed job is already a strong enough signal, and `total_saved` is not persisted on `scrape_jobs`.)

4. **Structured logging.** Every scheduler decision (spawn, skip-recent, skip-active, fail, cap-cancel, auto-pause) emits a one-line log with `[NightlyScheduler]` prefix and `country/category/reason` fields. `gcloud run logs read --filter="textPayload:NightlyScheduler"` gives a clean post-mortem feed.

## Operational notes

- **Cost / credit budget.** With ZeroBounce on, verification fires for every email found. ZeroBounce free tier is 100/mo — far below what 352 combos can produce. Surface this in the UI as a small "ZeroBounce credits remaining" badge inside the schedule card (data is already fetched elsewhere). If a quota guard is needed later, that's a follow-up.
- **Trustpilot rate-limits.** Parallelism default is 2. If the user bumps it to 5+ and sees scrape failures spike, the right fix is lowering parallelism — not changing the scheduler. Document this in the UI tooltip on the parallelism field.
- **Cloud Run `min-instances`.** Already 1 (campaign-scheduler depends on it). No infra change.

---

## Acceptance criteria

1. Migration applies cleanly on top of current production schema. `SELECT * FROM app_settings` returns one row with the default values above.
2. With `nightly_scrape_enabled=false`, no `scrape_jobs` rows are created with `source='nightly'`.
3. With `nightly_scrape_enabled=true` at 00:01 PHT, within 60 seconds a `scrape_jobs` row is created with `source='nightly'`, `country='AU'`, `category='gambling'` (first combo by category-major order).
4. With `parallelism=2`, no more than 2 `scrape_jobs` rows with `source='nightly'` and `status='running'` exist at any time.
5. At 14:00 PHT, no new `source='nightly'` jobs are spawned. Any `source='nightly'` job still in `status='running'` is allowed to continue and completes normally.
6. A combo with a `status='completed'` `scrape_jobs` row inside `rescrape_days` is not picked up by the scheduler on the next tick.
7. `POST /api/scrape/schedule/run-now` causes a dequeue within 60 seconds even outside the configured window.
8. `POST /api/scrape/schedule/stop` (a) sets `nightly_scrape_enabled=false`, and (b) cancels all `source='nightly'` jobs in `status='running'` via `cancelScrapeJob()`.
9. The new Finance categories (`money_insurance`, `investing_wealth`, `investment_service`) appear in the manual Scrape form's dropdown and are included in the nightly cycle.
10. The Scrape page shows a NightlyScheduleCard with live status. While a nightly job is running, the card text matches one of the five `status.phase` values.

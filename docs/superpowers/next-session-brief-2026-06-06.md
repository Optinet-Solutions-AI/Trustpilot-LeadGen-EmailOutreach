# Next-Session Brief — Tomorrow's Agenda

**Context from today (2026-06-05):** Shipped niche/location combobox UX + full FB group-first scrape pipeline + auto-translate + multilingual Gemini classifier. End-of-day proof: 32 handyman leads in London, 19 electrician leads in Frankfurt (via substring filter only; classifier had a thinking-budget bug that's now fixed but caused the Frankfurt classifier to reject all 34 surviving posts on the final verification run — that's actually correct behavior because group discovery surfaced lifestyle groups, not trade-specific groups).

Worker is on SHA `2cdd363`. Cloud Run on revision `trustpilot-crm-00281-9m7`. Frontend on Vercel auto-deploy.

---

## Top priority — Non-English market yield (Tier 1)

**Problem:** When scraping non-English cities, FB's group search returns generic city groups (events, lifestyle, expat) instead of trade-specific ones. The translated niche keyword search works, but most of the discovered groups are wrong-niche, so per-group searches return noise, and Gemini correctly rejects it. Frankfurt yielded 0 real-classifier leads even though architecture is sound.

**Fix:** Extend the existing `_is_consumer_facing_group` filter at `tools/scraper/platforms/facebook.py` (around line 2043 in `_sync_group_first_scrape`) to ALSO prefer groups whose names contain niche-relevant tokens. We currently filter OUT pro/job/supplier groups; we need to also positively filter IN trade/classifieds/marketplace groups.

**Knowledge needed:**
- `_is_consumer_facing_group` lives in `tools/scraper/platforms/facebook.py`
- Look at today's Frankfurt group list to see what FB returns: `Neu in Frankfurt`, `Frankfurt Events`, `Nightlife Frankfurt`, `EINTRACHT FRANKFURT NEWS` (bad — generic), `Kleinanzeigen Frankfurt und Umgebung` (good — classifieds), `Elektriker für alle` (good — niche-specific)
- Need a positive-keyword whitelist per language: `Kleinanzeigen / Marktplatz / Handwerker / Elektriker / Klempner` (German), `petites annonces / artisans` (French), `mercatino / annunci` (Italian), `clasificados / oficios` (Spanish), etc.
- Test: re-run electrician+Frankfurt — expected to drop the 30 lifestyle groups, keep 5 niche/classifieds groups, yield 5-15 real leads

**Estimated effort:** 1-2 hours including verification.

---

## Tier 2 — Reliability fixes

### 2a. Linux EC2 burns FB attempts

**Problem:** Linux EC2 worker race-claims FB jobs, immediately refuses ("Facebook scraping is not supported on Linux workers"), but the refusal increments `attempts`. With default `max_attempts=3`, Linux can burn all attempts before Windows polls. Today's Rome and London test jobs failed because of this.

**Knowledge needed:**
- The refusal logic is in `server/src/services/scrape-runner.ts` (or `scraper-worker.ts`) — look for the "Facebook scraping is not supported on Linux" error string
- The fix: when refusing, RELEASE the claim cleanly (revert to `status: 'pending'`, don't increment `attempts`) instead of failing it
- OR add `PLATFORM_EXCLUDE` filter to the Linux worker's `claim_next_pending_scrape_job` RPC call so it never even claims FB jobs

**Estimated effort:** 30-60 min.

### 2b. Task Scheduler never fires the deploy script

**Problem:** The `scraper-deploy` scheduled task on Windows EC2 is registered (State=Ready) but `LastRunTime` is blank — it has literally never executed. Every code deploy needs the manual `git pull / npm run build / nssm restart` paste-job in SSM.

**Knowledge needed:**
- Install script at `scripts/ec2-windows-install-deploy-schedule.ps1` (lines 38-66) configures the task with `New-ScheduledTaskTrigger -AtStartup` + `-Once -At (Get-Date).AddSeconds(30) -RepetitionInterval (New-TimeSpan -Minutes 5)`
- Principal is SYSTEM with `LogonType ServiceAccount -RunLevel Highest`
- Possible causes: SYSTEM account can't see git/npm/nssm on PATH (the deploy script tries to refresh PATH but maybe still fails); or the trigger config has a Windows-version-specific bug; or `Start-ScheduledTask` at the end of the install script never actually committed the task
- Diagnostic: `Get-ScheduledTaskInfo -TaskName scraper-deploy` should show LastRunTime; if blank, dig into Event Viewer's `Microsoft-Windows-TaskScheduler/Operational` log

**Estimated effort:** 30-60 min plus iteration time on Windows EC2.

### 2c. `used_today` doesn't auto-rollover at UTC midnight

**Problem:** The `social_accounts.used_today` counter never resets even though commit `2ac48b4` claimed to add auto-rollover. Today found it stuck at 489 from prior days; required manual reset.

**Knowledge needed:**
- The rollover logic should be in `_bump_counters` or `_claim_account` in `tools/scraper/platforms/facebook.py`
- It should check if `last_used_at` is from a prior UTC day and reset `used_today=0` before incrementing
- Look for the function that updates `used_today`, verify the rollover check exists, verify the date comparison uses UTC not local time

**Estimated effort:** 30 min.

---

## Tier 3 — Polish

### 3a. Filter precision — business false positives

"My My Lashes" (a beauty business) was saved as an electrician lead in today's Frankfurt run (when classifier was skipped). The substring filter `_looks_like_business_post` at `tools/scraper/platforms/facebook.py` doesn't catch all self-advertising patterns. Worth adding: detection of business-name handles + service-offer language in any language. Effort: 30-60 min plus test scrape.

### 3b. Wire `{{post_excerpt}}` campaign token

`lead_platform_posts.content_excerpt` is populated correctly (verified today — sample post excerpts include the West Hampstead handyman ask and the German Elektriker asks). But the template engine doesn't expose it as a campaign template token yet.

- File: `server/src/services/template-engine.ts` TOKEN_MAP around line 33-42
- Add: `post_excerpt: (l) => l.content_excerpt || ''` and `post_url: (l) => l.post_url || ''`
- May also need a join: `campaign-scheduler.ts` may need to fetch the most-recent `lead_platform_posts` row per lead at send time
- Effort: 1 hour.

---

## Tier 4 — Carried over from prior sessions

### 4a. Resume Instagram brainstorm

Paused yesterday on the sequencing question — Connect-IG sub-project first vs full IG scraper first. The May-18 spec lists IG as M9 of the master plan. Open in `docs/superpowers/specs/2026-05-18-social-platforms-design.md`.

### 4b. Rotate exposed secrets

`GEMINI_API_KEY`, `CRM_ACCOUNT_ENCRYPTION_KEY`, TightVNC password — all visible in transcript screenshots from two days ago. Need to:
- Generate new values
- Update local `.env`
- Update Cloud Run env: `gcloud run services update trustpilot-crm --region us-central1 --project=trustpilot-leadgen --update-env-vars 'KEY=VALUE'`
- Update Windows EC2 NSSM env: `nssm set scraper-worker AppEnvironmentExtra KEY=VALUE`
- Re-encrypt any `encrypted_cookies` rows in `social_accounts` if encryption key rotated (this is the hard one — needs a one-shot migration script)

Effort: 1-2 hours.

---

## Suggested order for tomorrow

1. **Group-discovery quality fix** (Tier 1) — highest yield impact, unlocks non-English markets
2. **Linux race-claim fix** (Tier 2a) — eliminates ~25% scrape failure rate
3. **Task Scheduler fix** (Tier 2b) — stops the manual-deploy dance
4. **`used_today` rollover** (Tier 2c) — eliminates manual cap resets
5. Tier 3 polish if time permits, OR pivot to Instagram brainstorm

Start with Tier 1 — the others are quality-of-life; Tier 1 is the only one that turns FB scraping from "works for English markets" to "works globally".

---

## How to pick up cold

1. Read this file
2. `git log -10 --oneline` to see today's commits (the FB group-first + auto-translate work)
3. `cat docs/superpowers/plans/2026-06-05-fb-group-discovery-flow.md` and `cat docs/superpowers/plans/2026-06-05-fb-niche-auto-translate.md` for the design context
4. Check Windows EC2 worker is alive: query `social_accounts.last_used_at` on the FB account row in Supabase
5. Pick a Tier 1 task and invoke `superpowers:brainstorming` if the design isn't already clear from this brief

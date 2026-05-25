# Local test guide — Social Platforms (M1–M11)

This is a step-by-step playbook for running the new Facebook + Instagram
lead-gen surface locally on your laptop. Nothing in here ships to Cloud
Run or EC2 — you run everything against `localhost` and live Supabase.

Branches/commits to test:
- `main` — has M1 (migration 039) + M2 (encryption helpers).
- `feat/social-platforms-rest` — has M3 → M11.

To get everything together, check out the rest branch on top of main:

```powershell
git checkout feat/social-platforms-rest
```

---

## 1. One-time setup

### 1a. Generate the cookie-encryption key

```powershell
# In any shell that can run openssl (Git Bash, WSL, or git's bundled one)
openssl rand -hex 32
```

Copy the 64-char hex output. Add it to your `.env`:

```env
CRM_ACCOUNT_ENCRYPTION_KEY=<paste-here>
```

The SAME value has to be visible to (a) the Express server and
(b) the Python scraper subprocesses — putting it in `.env` covers
both because `tools/scraper/run.py` and `login_flows.py` both load
`.env` at startup.

If you skip this step, the social-accounts surface will still load,
but the moment you click "Connect" the Python subprocess will
exit immediately with `EnvironmentError: CRM_ACCOUNT_ENCRYPTION_KEY
must be a 64-character hex string`.

### 1b. Install the new Python dependencies

```powershell
pip install -r requirements.txt
```

This pulls in the two new packages M2/M3 need:

- `cryptography>=42.0.0` — AES-256-GCM (M2)
- `undetected-chromedriver>=3.5.5` + `selenium>=4.18.0` — fingerprint-patched Chrome (M3 / M5 / M9)

`undetected-chromedriver` also needs a real Chrome install on the box.
If you don't have Chrome on the path, install it from
https://www.google.com/chrome/ before continuing.

### 1c. Confirm migration 039 is applied

Run this in the Supabase SQL editor (it should already be applied from
the M1 step earlier today):

```sql
SELECT * FROM social_accounts LIMIT 0;
SELECT * FROM lead_platform_posts LIMIT 0;
SELECT author_handle FROM lead_platform_presences LIMIT 0;
SELECT social_account_id FROM scrape_jobs LIMIT 0;
SELECT channel FROM campaign_leads LIMIT 0;
```

All 5 should return "Success. No rows returned". If any error,
re-apply [`supabase/migrations/039_social_account_attribution.sql`](../supabase/migrations/039_social_account_attribution.sql).

---

## 2. Start the servers

Two terminals, both pointed at the project root.

### Terminal A — API

```powershell
cd server
npm install
npm run dev
```

You should see the usual `[Server] Listening on http://localhost:3001`
plus `[CampaignScheduler] tick interval started`. No new startup logs
for the social work — it's all lazy.

### Terminal B — Frontend

```powershell
cd frontend
npm install
npm run dev
```

Wait for `▲ Next.js ready on http://localhost:5173`. Open that URL
in your browser.

### Sanity check

In the sidebar you should see a new **Social Accounts** entry (icon
"share") right below **Email Accounts**. If it's missing, the
frontend didn't pick up [Sidebar.tsx](../frontend/src/components/Sidebar.tsx) — kill the dev server
with Ctrl-C and restart it (Next's HMR is unreliable for sidebar
nav changes).

---

## 3. Connect your first Facebook account

1. Click **Social Accounts** in the sidebar → page loads with empty
   "Facebook (0)" and "Instagram (0)" sections.
2. Click **Add account** (top right).
3. Pick **Facebook** in the platform dropdown.
4. Enter your real Facebook username/handle (e.g. `john.smith.123`).
5. Optional label (e.g. `OptiRate-FB-01`).
6. Click **Save** — the row appears in the Facebook section with status
   pill **disabled**. No cookies yet.
7. Click **Connect** on the new card.

What happens next:
- The server spawns [tools/scraper/shared/login_flows.py](../tools/scraper/shared/login_flows.py) as a subprocess.
- A **non-headless Chrome window opens on your laptop** with
  `facebook.com/login`.
- The card shows a live log:
  ```
  [1] Browser launching
  [2] Log in inside the browser window
  ```
- Log into Facebook in that browser window. Complete 2FA if asked.
- The moment Facebook drops a valid `c_user` cookie, the harness
  catches it and you'll see:
  ```
  [3] Cookies captured — 18 cookies
  [4] Done
  ```
- Browser auto-closes. Card refreshes: status pill flips to **active**,
  a `cookies on file` badge appears.

If anything goes wrong:
- Browser never opens → check Chrome is installed and on PATH.
- Browser opens but the harness exits with `failed:login-timeout` → you
  took longer than 10 minutes; raise `SOCIAL_LOGIN_TIMEOUT_SECONDS` in
  `.env` and retry.
- Server logs show `ModuleNotFoundError: undetected_chromedriver` →
  re-run `pip install -r requirements.txt` and restart Terminal A.

### Sanity check — DB

```sql
SELECT id, platform, handle, status, length(encrypted_cookies) AS blob_len, last_login_at
  FROM social_accounts
 WHERE platform = 'facebook';
```

One row, `status='active'`, `blob_len` around 500-1500, `last_login_at`
recent. The `encrypted_cookies` value will NOT be readable as plaintext
— that's the M2 layer doing its job.

---

## 4. Run your first Facebook scrape

1. Sidebar → **Lead Scraping**.
2. Platform dropdown → pick **Facebook**.
3. Lead type radio → **People asking for a service (post authors)**.
4. Keyword → type something realistic for your niche, e.g.:
   - `looking for a dentist`
   - `need a plumber recommendation`
   - `anyone know a good roofer`
5. Leave **groups_only** unchecked for the first run (wider net).
6. Leave dates blank.
7. Click **Start scrape**.

What happens:
- POST `/api/scrape` creates a `scrape_jobs` row.
- The local scrape-runner picks it up and spawns:
  ```
  py -m tools.scraper.run --platform facebook --action search-posts \
     --filters '{"lead_type":"consumers","query":"looking for a dentist"}' \
     --output .tmp/raw_scrape_results.json
  ```
- A second undetected-chromedriver opens, hydrates with your saved
  cookies, hits `facebook.com/search/posts/?q=...`, and scrolls.
- For each match you'll see `PROGRESS:post_found:<url>` in the live
  progress card.
- After search finishes, the runner kicks off `--action enrich-authors`,
  which dedups authors and visits each profile.
- Finally `_upsert_nontrustpilot_lead` writes:
  - One row per unique author into `leads` + `lead_platform_presences`.
  - One row per observed post into `lead_platform_posts`.

### Sanity check — DB

```sql
-- Authors landed?
SELECT l.id, l.company_name, lpp.profile_url, lpp.author_handle
  FROM leads l
  JOIN lead_platform_presences lpp ON lpp.lead_id = l.id
 WHERE lpp.platform = 'facebook'
 ORDER BY l.created_at DESC
 LIMIT 20;

-- Posts attached?
SELECT lpp.platform, lpp.post_url, lpp.content_excerpt, lpp.scraped_at
  FROM lead_platform_posts lpp
 ORDER BY lpp.scraped_at DESC
 LIMIT 20;
```

If both are populated, the end-to-end pipeline is working.

### ⚠️ Reality check on selectors

Facebook ships DOM redesigns roughly monthly. The selectors in
[tools/scraper/platforms/facebook.py](../tools/scraper/platforms/facebook.py) (functions starting with
`_extract_*` and the `find_elements(...)` calls inside
`_sync_search_posts` / `_sync_enrich_authors`) are best-effort
against FB's DOM as of mid-2026.

You will almost certainly need to tune them on first real run. Telltales:
- `total_found=0` when you can clearly see matching posts in a real
  browser → the `div[role="article"]` selector is no longer the
  post-card anchor. Inspect the page, find the new wrapper, patch
  `_extract_posts_from_search_page`.
- `enrich_failed` for every author → the title-parsing logic is wrong.
  Inspect a profile page, find the display-name source (often `<h1>`),
  patch `_sync_enrich_authors`.

Structure (account claim, dedup, SSE event names, counter bumps,
captcha detection) is stable across redesigns — only the CSS queries
change.

---

## 5. Run a Facebook business-mode scrape

1. Same form. Lead type → **Businesses in a niche (page owners)**.
2. Country → US.
3. Page category slug → e.g. `dentist`, `plumber`, `restaurant`.
4. **Start scrape**.

This drives `scrape_listing` → `enrich_profiles` pointed at
`facebook.com/pages/category/<slug>/`.

DB check:

```sql
SELECT l.company_name, lpp.profile_url, lpp.is_business_profile
  FROM leads l
  JOIN lead_platform_presences lpp ON lpp.lead_id = l.id
 WHERE lpp.platform = 'facebook' AND lpp.is_business_profile = true
 ORDER BY l.created_at DESC LIMIT 10;
```

You should see Page-owner leads with `is_business_profile=true`.

---

## 6. Test Instagram

Repeat steps 3–4 with **Instagram** picked:
- Connect an IG account in Social Accounts (browser goes to
  `instagram.com/accounts/login/`).
- Run a hashtag search: platform=Instagram, lead type=consumers,
  hashtag=`dentaltips` (no `#`, the form strips it).

Same DB-check queries work; swap `platform='instagram'`.

---

## 7. Test the captcha-recovery banner

To test the UI without waiting for a real captcha:

```sql
UPDATE social_accounts SET status = 'checkpoint',
  checkpoint_reason = 'manual test',
  last_checkpoint_at = now()
 WHERE platform = 'facebook' LIMIT 1;
```

Within 30 seconds (banner poll interval) you'll see an amber banner
across the top of every page:

> ⚠️ **1** facebook account hit a captcha. Open Social Accounts and
> click **Recover** on the affected row to clear it. **Open**

Click "Open" → Social Accounts → the affected card shows **checkpoint**
pill and a **Recover** button.

Revert when done:

```sql
UPDATE social_accounts SET status = 'active', checkpoint_reason = NULL
 WHERE checkpoint_reason = 'manual test';
```

---

## 8. Test the campaign tokens

Pick any social lead from your previous scrape, drop it into a new
campaign with a template like:

```
Hi {{company_name}} — saw your post about {{post_excerpt}}.
Original: {{post_url}}

We help with...
```

Run a test flight. The rendered output should substitute the actual
excerpt and URL from `lead_platform_posts` (joined on `lead_id`,
most recent post wins).

If the lead has no posts (Page-owner scrape from step 5), tokens
degrade gracefully:
- `{{post_excerpt}}` → `your recent post`
- `{{post_url}}` → empty string

---

## 9. What's NOT testable yet

Deliberate v2 cuts (see the master plan's "out of scope"):

- **Actual DM sending** — M11 only stubs the contract. Campaign rows
  with `channel='dm_facebook'` sit at `status='pending'` forever.
- **Real-time notifications** — banner polls every 30s. SSE/websocket
  push lands when NotificationsContext gets its own channel.
- **Cross-platform identity dedup** — a Facebook lead and a Yelp lead
  for the same business stay as separate `leads` rows.
- **Captcha-solving APIs** — 2captcha / Anti-Captcha is v2; v1 is
  operator-driven recovery.

---

## Feedback I'd actually find useful

When you do this run-through, the things most worth telling me:

1. **Did the connect flow work end-to-end?** Or which `STAGE:` event
   did it die on?
2. **What did the post-search results look like?** Real posts? Noise?
   Empty? (Drives selector tuning.)
3. **Did the lead-type radio toggle feel right** in the ScrapeForm UI?
4. **Anything else friction-y** — copy that didn't read right, a
   button position that's confusing, a status pill color that confused
   you, a SQL query that timed out.

All of that goes back into the next pass.

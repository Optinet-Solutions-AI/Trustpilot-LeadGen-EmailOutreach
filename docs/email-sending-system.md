# Email Sending System — Complete Reference (Plan + Implementation)

> A self-contained blueprint of the multi-provider cold-outreach email engine: architecture, database schema, sender modules, the scheduling pipeline, templating, warmup, reply tracking, verification, bounce handling, API surface, and the campaign wizard. Written so it can be **lifted into another project**. Stack-specific names (OptiRate, Trustpilot, `trustpilot-crm`) are legacy labels — the system itself is platform-agnostic.

**Stack:** Node.js + Express + TypeScript (ESM, `.js` import specifiers on `.ts` source) · Supabase (Postgres) · React + Vite frontend · Deployed on Google Cloud Run (API) + Vercel (frontend).

---

## 1. The Plan — Design Principles

The system was built around a few hard rules. If you reuse it, keep these — most exist because of a production incident.

1. **No single "sender" env var.** Every outgoing email resolves to a row in the `email_accounts` table. An account carries its own auth method, caps, warmup state, and DNS status. The env-var Gmail account survives only as a synthetic fallback (`__env__`).
2. **The database is the queue.** The `/send` route does *not* send. It computes a `scheduled_at` timestamp per recipient, writes it to `campaign_leads`, and returns. A polling scheduler (`setInterval`, 60s) sends what's due. This makes sending **crash-safe across Cloud Run instance churn** — a killed instance loses nothing because the queue is in Postgres.
3. **Atomic claim before every send.** A conditional `UPDATE … WHERE id AND <time_col> = original RETURNING id` row-locks the candidate so only one scheduler tick (across any number of replicas) wins it, and pushes the time column (`scheduled_at` / `next_step_at`) 10 minutes out so an in-flight send can't be re-claimed. This is the core duplicate-send guard. **Retry is implicit:** if a send crashes after claiming, the time column is now 10 min ahead; once it lapses the row is simply due again (`<= NOW()`) on a normal tick — there is no separate retry job.
4. **Idempotency via `lead_notes`.** Each successful send writes a `lead_notes` row. Initial sends carry **no `step_number`** in metadata; follow-ups carry `step_number`. Two unique partial indexes enforce "at most one send per logical step." Before sending, the scheduler checks for an existing note and skips if found.
5. **Adapter pattern for providers.** `sendEmail()` is a facade; Gmail OAuth, SMTP (nodemailer), Brevo (REST), and mock are interchangeable behind it. An `email_accounts` row's `auth_type` decides the path per-send.
6. **"Mandatory" test flight.** A campaign should never go live without a single test send first. **This is a UI convention, not an API constraint** — `POST /:id/send` will dispatch without a prior test flight. If you need a hard guarantee, enforce it server-side (see §11.3).
7. **Hard global kill switch.** `EMAIL_SENDING_PAUSED_UNTIL` (ISO timestamp) halts every send tick while in the future, overriding all DB state. Used during deliverability incidents.
8. **Free-first verification.** Syntax → DNS → catch-all → SMTP probe resolve most addresses for free; paid APIs (ZeroBounce → MillionVerifier → Hunter) are tail stages that fire only on `unknown`.
9. **Deliverability is a first-class concern.** Per-account warmup ramps, per-account daily/hourly caps, MX/SPF/DMARC/DKIM gating before send, `List-Unsubscribe` headers, domain-aligned Message-IDs, randomized non-cron send timing, and spintax content variation.

### High-level data flow

```
Campaign Wizard (UI)
   └─ POST /api/campaigns                 → create campaign (draft) + campaign_steps
Launch
   └─ POST /api/campaigns/:id/test-flight → 1 verification send (mandatory, UI-gated)
   └─ POST /api/campaigns/:id/send        → gate chain, then runCampaignSend (fire-and-forget)
                                             ├─ TEST mode  → send all immediately
                                             └─ LIVE mode  → assignScheduledTimes() → write campaign_leads.scheduled_at; return
Background (setInterval, started in server.ts):
   campaign-scheduler  60s  → send due INITIAL emails; finalize campaigns; bounce check (every 5th tick)
   sequence-scheduler  60s  → send due FOLLOW-UP steps
   reply pollers       10m  → Gmail API + IMAP; classify human/auto/ticket; flip statuses
   duplicate monitor   5m   → watchdog alert on any double-send
   warmup schedulers   10m / 60s → reputation-building sends
```

---

## 2. Environment Variables

| Var | Used by | Effect |
|---|---|---|
| `EMAIL_PLATFORM` (`config.emailPlatform`) | schedulers, server | `none` = direct mode (schedulers active). Any other value hands scheduling to an external platform adapter (Instantly) and the local schedulers stand down. |
| `EMAIL_MODE` (`config.emailMode`) | sender facade, bounce/reply | `mock` / `gmail` / `brevo` (default `mock`). Selects the **default** sender path. **For a multi-account fleet set `EMAIL_MODE=gmail`** — this is the "multi-account orchestration" mode: `buildSenderPool` only activates under `gmail`, and the facade then routes each send by the account's `auth_type` (an `auth_type='smtp'` row always sends via nodemailer regardless of this var). So even an SMTP-only fleet runs with `EMAIL_MODE=gmail`. Gmail bounce + Gmail reply pollers only run when `gmail`. |
| `SCHEDULERS_ENABLED` | server bootstrap | `false` suppresses the campaign + sequence schedulers on this instance. **Set this on the autoscaled API service and run schedulers on one dedicated `min=max=1` instance** to avoid N replicas racing the same due rows. Default `true`. |
| `EMAIL_SENDING_PAUSED_UNTIL` | both schedulers | ISO timestamp. While in the future, every send tick is skipped. Hard kill switch; overrides DB state. (Colleague-warmup deliberately ignores it.) |
| `EMAIL_DAILY_CAP` / `EMAIL_HOURLY_CAP` (`config.rateLimits`) | rate-limiter | Global caps + warmup ceiling; also the per-account fallback when an account's `daily_cap`/`hourly_cap` is null. |
| `EMAIL_MIN_DELAY` / `EMAIL_MAX_DELAY` | config | Loaded into config (defaults `240000`/`540000` ms = 4–9 min) but **effectively unused by the schedulers** — they use a hardcoded 2000ms inter-send pause and the schedule-engine governs real spacing. Safe to ignore on reuse. |
| `EMAIL_FROM` (`config.gmail.fromEmail`) | sender fallback, warmup key | Env sender address; default `sender_email` when no account row; key for the global warmup counter. |
| `EMAIL_FROM_NAME` | template engine, config | Display-name fallback; also the brand substituted for `[Your Name]`-style placeholders (default `OptiRate`). |
| `EMAIL_TEST_MODE` / `TEST_EMAIL_ADDRESS` | test-mode | `true` redirects every outbound email to the test address(es) (comma-separated supported) and prefixes the subject with `Test mode- `. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | env Gmail client | OAuth creds for the env `__env__` account (also reused for the OAuth connect flow's token exchange). |
| `BREVO_API_KEY` | Brevo sender | Brevo REST key (only if `EMAIL_MODE=brevo`). |
| `ZEROBOUNCE_API_KEY` | verify stage 5 | Tier-1 paid verifier. Unset → skipped. |
| `MILLIONVERIFIER_API_KEY` | verify stage 6 | Tier-2 paid verifier (fires on ZB `unknown`). Unset → no-op. |
| `HUNTER_API_KEY` | verify stage 7 + enrichment | Tier-3 last-resort verifier. Unset → no-op. |
| `HUNTER_MAX_CALLS_PER_HOUR` | hunter cap | Rolling-hour cap (default 20). |
| `SMTP_PROBE_HELO` / `SMTP_PROBE_FROM` | verify stages 3/4 | HELO domain + MAIL FROM for the free SMTP probe (default your sending domain). |
| `AUTO_REPLY_HANDLING_ENABLED` | reply tracker | Default ON (`!== 'false'`). When on, auto-replies get `status='auto_replied'` + contact discovery; when off, they fall back to legacy `replied`. |
| `AUTO_QUEUE_URLS_FROM_REPLIES` | reply tracker | Default OFF. When off, URL candidates harvested from auto-replies are not queued (emails always are). |
| `COLLEAGUE_WARMUP_ENABLED` | colleague warmup | Kill switch (default false). |
| `COLLEAGUE_WARMUP_START_DATE` | colleague warmup | `YYYY-MM-DD` (Manila); day-1 of the ramp. Unset → no plan. |
| `DUPLICATE_SEND_MONITOR_*` | duplicate monitor | `INTERVAL_MS` (300000), `WINDOW_MIN` (5), `EMAIL`, `FROM_EMAIL`, `WEBHOOK_URL`. No-op unless EMAIL or WEBHOOK is set. |
| `INSTANTLY_WEBHOOK_SECRET` | webhook route | Shared secret for inbound platform-webhook HMAC/static-secret verification (§11.2). Only relevant in platform mode. |
| `CRM_ACCOUNT_ENCRYPTION_KEY` | encryption lib | 64-hex (32-byte) AES-256-GCM key. **Currently only used for social-account cookies, NOT email creds** — see §4.5. |

---

## 3. Database Schema (Supabase / Postgres)

All UUID PKs use `gen_random_uuid()` (needs `pgcrypto`). Migrations are additive; "Since" cites the migration that introduced the column.

### 3.1 `campaigns` — campaign definitions + templates

| Column | Type | Notes | Since |
|---|---|---|---|
| `id` | uuid PK | | 001 |
| `name` | text NOT NULL | | 001 |
| `template_subject` | text | supports `{{token}}` + `{spintax\|variants}` | 001 |
| `template_body` | text | HTML; tokens + spintax | 001 |
| `status` | text | default `draft`. CHECK `('draft','sending','sent','completed')` (an index also references `'active'`) | 001/003 |
| `include_screenshot` | boolean | default `false` | 001 |
| `total_sent` / `total_opened` / `total_replied` / `total_bounced` | int | default 0; recomputed live from `campaign_leads` | 001 |
| `total_auto_replied` | int | default 0; counts auto-replies separately so reply-rate stays human-only | 028 |
| `sent_at` / `created_at` | timestamptz | | 001 |
| `filter_country` / `filter_category` | text | persisted for duplication | 005 |
| `platform_campaign_id` / `email_platform` | text | external-platform IDs; unused in Gmail/SMTP mode | 006 |
| `sending_schedule` | jsonb | `{timezone,startHour,endHour,days[],dailyLimit,senderAccountIds[]}` — NULL = platform default | 008 |
| `campaign_type` | text | default `outreach`. CHECK `('outreach','discovery_followup')` — `discovery_followup` targets `leads.discovered_email` | 028 |
| `parent_campaign_id` | uuid | FK → campaigns, `ON DELETE SET NULL` | 028 |

### 3.2 `campaign_leads` — per-recipient send tracking (the queue)

| Column | Type | Notes | Since |
|---|---|---|---|
| `id` | uuid PK | | 001 |
| `campaign_id` | uuid FK → campaigns `ON DELETE CASCADE` | | 001 |
| `lead_id` | uuid FK → leads `ON DELETE CASCADE` | | 001 |
| `email_used` | text | the address actually targeted | 001 |
| `status` | text | default `pending`. CHECK `('pending','sent','opened','replied','auto_replied','bounced','skipped')` | 001/028/038 |
| `sent_at`/`opened_at`/`replied_at`/`bounced_at` | timestamptz | | 001 |
| `reply_snippet` | text | reply preview | 005 |
| `gmail_message_id` / `gmail_thread_id` | text | reply/bounce threading (SMTP reuses `gmail_message_id` to store its RFC822 Message-ID) | 003 |
| `current_step` | int | default 1; sequence position | 007 |
| `next_step_at` | timestamptz | when next follow-up is due | 007 |
| `sequence_completed` / `sequence_paused` | boolean | default false | 007 |
| `scheduled_at` | timestamptz | when this initial email fires | 011 |
| `sender_email` | text | **which account actually sent** — authoritative per-account count log | 016 |
| `reply_read_at` | timestamptz | NULL = unread reply (notification badge) | 017 |
| `skip_reason` | text | e.g. `already_contacted_in_another_campaign` | 038 |
| `channel` | text NOT NULL | default `email`. CHECK `('email','dm_facebook','dm_instagram')` | 039 |

**Unique:** `(campaign_id, lead_id)` — the upsert conflict key.
**Key indexes:** partial on `scheduled_at` where `status='pending'`; `(sender_email, sent_at DESC)`; partial on `next_step_at` where not completed/paused; partial on `gmail_thread_id`/`gmail_message_id`.

### 3.3 `campaign_steps` — multi-step follow-up sequences

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `campaign_id` | uuid FK `ON DELETE CASCADE` | |
| `step_number` | int NOT NULL | step 1 = initial template; follow-ups are 2,3,… |
| `delay_days` | int NOT NULL | days after the previous step |
| `template_subject` / `template_body` | text NOT NULL | |
| `created_at` | timestamptz | |

**Unique:** `(campaign_id, step_number)`.

### 3.4 `email_accounts` — sender mailboxes (single source of truth)

| Column | Type | Notes | Since |
|---|---|---|---|
| `id` | uuid PK | | 009 |
| `email` | text NOT NULL UNIQUE | dup insert → Postgres `23505` → HTTP 409 | 009 |
| `from_name` | text NOT NULL | display name | 009 |
| `provider` | text NOT NULL | human label (`Bluehost (Titan SMTP)`, `DreamHost (SMTP)`, `Gmail (warmup peer)`, …) | 009 |
| `auth_type` | text NOT NULL | `gmail_oauth` / `smtp` / `app_password` / `instantly` | 010 |
| `email_provider` | text NOT NULL | `gmail` / `smtp` (derived) | 013 |
| `status` | text NOT NULL | `active` / `paused` / `error` | 009 |
| `is_cold_sender` | boolean NOT NULL | default true. `false` = warmup-pool only, never used for campaigns | 023 |
| `notes` | text | | 009 |
| **SMTP/IMAP** | | | |
| `smtp_host` / `smtp_user` / `smtp_password` | text | **plaintext** (see §4.5) | 009 |
| `smtp_port` | int | | 009 |
| `smtp_secure` | text NOT NULL | default `tls`. `tls` / `ssl` (port 465) / `none` | 010 |
| `imap_host` / `imap_user` / `imap_pass` | text | for Sent append + reply polling | 013 |
| `imap_port` | int | default 993 | 013 |
| **Gmail OAuth / app-password** | | | |
| `gmail_client_id` / `gmail_client_secret` / `gmail_refresh_token` | text | per-account OAuth creds (**plaintext**) | 010 |
| `app_password` | text | (**plaintext**) | 010 |
| **Caps / warmup** | | | |
| `daily_cap` | int | NULL → env `EMAIL_DAILY_CAP` | 016 |
| `hourly_cap` | int | NULL → env `EMAIL_HOURLY_CAP` | 016 |
| `warmup_enabled` | boolean NOT NULL | default false (true admits to in-pool warmup) | 012 |
| `warmup_daily_target` | int NOT NULL | default 5 (in-pool warmup sends/day) | 012 |
| `warmup_started_at` | timestamptz | sticky across off/on toggles; drives the ramp | 023 |
| `warmup_target_cap` | int NOT NULL | default 50 (cap to ramp to) | 023 |
| `warmup_ramp_days` | int NOT NULL | default 21 | 023 |
| **DNS cache** | | | |
| `dns_mx` / `dns_spf` / `dns_dmarc` | boolean | cached check results | 016 |
| `dns_dkim` | boolean | 4th badge (code degrades gracefully if absent) | 035 |
| `dns_checked_at` | timestamptz | TTL 6h | 016 |
| `created_at` | timestamptz NOT NULL | | 009 |

> The **effective** daily cap is not stored — it's computed at read time by `getRampedDailyCap()` (see §6.4).

### 3.5 Supporting tables

- **`email_warmup_state`** (PK `account_email`): `start_date`, `lifetime_sent`, `updated_at` — persistent counter for the global env-account warmup ramp.
- **`warmup_emails`**: the in-pool warmup state machine log. Columns include `from_account`, `to_account`, `subject`, `body`, `warmup_uid` (UNIQUE, embedded in subject), `reply_body`, `stage` (`pending_open → pending_reply → pending_read → complete|failed`), `process_after`, threading IDs, and the open/reply/read timestamps.
- **`follow_ups`**: per-lead CRM **reminders** (`due_date`, `note`, `completed`). **Distinct from `campaign_steps`** — don't conflate.
- **`lead_notes`**: activity log. `type` includes `email_sent`, `email_opened`, `email_replied`, `email_bounced`, `auto_reply_received`, `auto_reply_no_contacts`, `auto_reply_candidate`, `verification`, plus discovery types. **Two UNIQUE partial indexes (migration 040)** enforce one send-note per logical step:
  - `idx_lead_notes_unique_initial_send` on `(lead_id, metadata->>'campaign_id')` where NOT `metadata ? 'step_number'`
  - `idx_lead_notes_unique_followup_send` on `(lead_id, metadata->>'campaign_id', metadata->>'step_number')` where `metadata ? 'step_number'`
- **`discovered_contacts`**: review queue for emails/URLs harvested from auto-replies (`kind` email/url, `status` pending_review/accepted/dismissed/spawned_lead).
- **`domain_intel`**: per-domain cache used by the verification cascade's catch-all probe (stage 3, §9) — stores the catch-all/MX result with a 7-day TTL so repeated addresses on the same domain don't re-probe. **Required if you port verification.**
- **`leads`** (recipient identity): relevant columns `primary_email`, `website_email`, `verification_status` (CHECK `valid/invalid/catch-all/unknown`), `email_verified` bool, `outreach_status` (CHECK `new/contacted/replied/converted/lost`), `discovered_email` (+ status/source) for discovery follow-ups.

---

## 4. Sender Modules (the adapter layer)

### 4.1 Facade — `email-sender.ts`

`sendEmail(to, subject, html, options?, account?)` is the single entry point every scheduler calls. Routing, in priority order:

1. `account.auth_type === 'smtp'` → `sendEmailSmtp()` (nodemailer). **Wins regardless of `EMAIL_MODE`.**
2. else `EMAIL_MODE='gmail'` → Gmail API sender (passes `account` as `GmailSenderAccount`).
3. else `EMAIL_MODE='brevo'` → Brevo REST (`account` is dropped — Brevo ignores per-account routing).
4. else → mock (console log).

```ts
type SendEmailOptions = { screenshotPath?; inReplyTo?; references?; gmailThreadId? };
type SendEmailResult  = { success; messageId?; threadId?; error? };
type SenderAccount    = GmailSenderAccount | SmtpSenderAccount;
//   GmailSenderAccount = { email, fromName, gmail }            // gmail = authed googleapis client
//   SmtpSenderAccount  = { email, fromName, auth_type:'smtp', smtp_host, smtp_port, smtp_user, smtp_password, imap_* }
```

When `account` is omitted, the Gmail sender falls back to the env account.

### 4.2 Gmail sender — `email-sender.gmail.ts` + `gmail-client.ts`

- **Auth:** OAuth2 refresh-token flow via `googleapis`. Two factories: `getGmailClient()` (singleton for the env account, from `GOOGLE_CLIENT_*`), and `createGmailClientFromCredentials(id, secret, refreshToken)` (per-DB-account, no singleton).
- **⚠️ `app_password` routing quirk (reconcile on reuse):** The facade only special-cases `auth_type==='smtp'` → nodemailer; **everything else (incl. `app_password`) falls to the Gmail path.** And `sender-loader.ts` `mapRow()` only returns a sender for an `app_password` row when the `gmail_client_id/secret/refresh_token` columns are populated — i.e. it builds a Gmail **OAuth** client, *not* a Gmail-SMTP app-password transport. Yet onboarding (`POST /test`, `POST /peer`) verifies app passwords via nodemailer on `smtp.gmail.com:587`. So the **test path and the send path disagree** for `app_password`. On reuse, pick one: either drop `app_password` and use `gmail_oauth`, or route `app_password` through the SMTP sender (`smtp.gmail.com:587`) for consistency.
- **Send:** MIME built with nodemailer `MailComposer`, base64**url**-encoded, sent via `gmail.users.messages.send({ userId:'me', requestBody:{ raw, threadId? } })`. Returns Gmail's message id + thread id.
- **Deliverability headers always set:** `List-Unsubscribe: <mailto:from?subject=unsubscribe>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and a **domain-aligned Message-ID** `<uuid@senderDomain>` for DKIM/SPF alignment.
- **HTML:** `ensureHtml()` wraps plain text in `<p>`/`<br>`; `htmlToPlainText()` builds a multipart/alternative text part.
- **Inline screenshot:** if `options.screenshotPath`, fetch (http with 3-attempt retry) or read local file → push inline CID attachment (`cid: 'trustpilot-screenshot'`, `image/png`, `contentDisposition:'inline'`) and append `<img src="cid:...">`. Fetch failure → send without image.
- **Threading:** `In-Reply-To` ← `wrapAngles(inReplyTo)`; `References` ← passthrough or wrapped, falling back to `inReplyTo`; `gmailThreadId` → `requestBody.threadId` so Gmail grafts onto the existing thread regardless of header interpretation.
- **Sent folder:** native (Gmail auto-files sent mail).

### 4.3 SMTP sender — `email-sender.smtp.ts`

- **Auth:** nodemailer, **pooled transporter cached by `smtp_user`** (`pool:true, maxConnections:2, maxMessages:100`), `secure = (port===465)`. Caching avoids a TLS handshake per send.
- **Message-ID:** **pre-generated and stable** (`<base36time-rand@domain>`) so the sent message and the IMAP-appended copy share one header; the function returns this id (not nodemailer's) so the DB correlates.
- **Threading:** same `In-Reply-To`/`References` logic as Gmail; `gmailThreadId` ignored.
- **Sent folder via IMAP APPEND:** after a successful send, if IMAP creds exist, `appendToSentFolder()` runs **fire-and-forget** — recompiles the identical MIME, connects with `imapflow`, finds the Sent mailbox by SPECIAL-USE `\Sent` then name heuristics (`sent`, `sent messages`, `sent items`, `/sent/i`), `append(path, raw, ['\\Seen'])`. A failure only logs a warning.

### 4.4 Brevo + mock

- **Brevo** (`email-sender.brevo.ts`): `POST https://api.brevo.com/v3/smtp/email` with `api-key` header. No per-account routing, **no threading, screenshot must be a URL in the HTML** (the `screenshotPath` option is ignored). Sets the same `List-Unsubscribe` headers.
- **Mock** (`email-sender.mock.ts`): logs and returns true; the batch variant marks `campaign_leads` sent.

### 4.5 ⚠️ Credential storage

**Email-account credentials (`smtp_password`, `imap_pass`, `app_password`, `gmail_client_secret`, `gmail_refresh_token`) are stored in PLAINTEXT.** They're written raw on insert and read straight into nodemailer / the Gmail factory. The AES-256-GCM helper (`lib/encryption.ts`, key `CRM_ACCOUNT_ENCRYPTION_KEY`) exists but is used only for `social_accounts.encrypted_cookies`. **If you reuse this, apply that GCM helper to the email credential columns — they're currently unprotected at rest.**

---

## 5. Account Onboarding & DNS (`routes/email-accounts.ts`, mounted `/api/email-accounts`)

| Method + Path | Purpose |
|---|---|
| `GET /` | List accounts. `?role=sender` → `is_cold_sender=true`; `?role=peer` → false; unfiltered prepends a synthetic `__env__`. Computes per-account `dailySent`/`hourlySent` (24h/1h from `campaign_leads`), ramped cap, warmup status, and lazily refreshes stale DNS (6h TTL) for SMTP accounts. |
| `POST /oauth/exchange` | **Gmail OAuth connect.** Body `{code, clientId, clientSecret, redirectUri}` → `getToken(code)` → returns `{refreshToken, email}` for the frontend to persist via `POST /`. Errors if no refresh token (instructs revoke at myaccount.google.com/permissions). |
| `POST /test` | Verify creds **without saving**. Branches by `authType`: `gmail_oauth` (validate refresh token), `app_password` (nodemailer `smtp.gmail.com:587`, strips spaces), `smtp` (nodemailer `verify()`), `instantly` (no-op). |
| `POST /` | Generic create. Inserts an `email_accounts` row; `email_provider` derived; SMTP mirrors `smtp_user/password` into `imap_user/pass`; defaults warmup fields. |
| `POST /bluehost` | One-click **Bluehost/Titan**: defaults `smtp.titan.email:465` + `imap.titan.email:993`. Body `{email, fromName, password}`. Soft IMAP test (failure → warning, still saves). |
| `POST /dreamhost` | One-click **DreamHost** SMTP/IMAP. |
| `POST /peer` | **Warmup-peer** onboarding. Auto-detects provider from a free-host map (gmail/yahoo/aol/outlook/icloud), strips app-password spaces, **requires both SMTP+IMAP to verify**, inserts `is_cold_sender:false`. |
| `PATCH /:id` | Update `dailyCap`, `hourlyCap`, `fromName`, `status`, `notes`, `isColdSender`, `warmupTargetCap`, `warmupRampDays`. `__env__` read-only. |
| `POST /:id/dns-refresh` | Re-run `verifyDomainDNS(domain)`, write `dns_*` + `dns_checked_at`. |
| `DELETE /:id` | Delete (not `__env__`). |

**DNS checker (`services/dns-checker.ts`):** uses Node `dns/promises`. `verifyDomainDNS(domain)` returns `{mx, spf, dmarc, dkim}` booleans (this is what routes call). `checkDomainHealth()` adds provider classification (`classifyMxProvider` against patterns for Google, Outlook, Zoho, Proton, Titan/Bluehost, MailChannels/DreamHost, SES, SendGrid, Mailgun, …). DKIM probes provider-specific selectors (Google `google`, M365 `selector1/2`, Titan `titan1/2`, DreamHost `dreamhost/mailchannels`) plus generic ones, matching `<selector>._domainkey.<domain>`.

> Don't confuse this with `email-validator/dns-check.ts`, which validates **recipient** emails (pinned `8.8.8.8`/`1.1.1.1` resolvers, A-record implicit-MX fallback, disposable-domain flagging). That's §9, not account DNS.

---

## 6. The Sending Pipeline

### 6.1 Bootstrap — `server.ts`

Inside the `app.listen` callback:
- **Orphaned-campaign reset:** `campaigns WHERE status='sending' AND platform_campaign_id IS NULL` with zero pending scheduled leads → reset to `draft` (the in-memory send loop died before scheduling persisted); with >0 → leave `sending` so the scheduler resumes. Cross-restart recovery for Cloud Run churn.
- `rateLimiter.init()` loads global warmup state.
- **Scheduler gate:** `schedulersEnabled = (SCHEDULERS_ENABLED ?? 'true') !== 'false'`. When true, starts `startSequenceScheduler()` + `startCampaignScheduler()`. When false, both are suppressed (run on a dedicated single instance).
- **Always started:** duplicate-send monitor, reply pollers (10 min), warmup schedulers, discovery worker. Platform-sync only when `emailPlatform !== 'none'`.

### 6.2 Initial sends — `campaign-scheduler.ts`

`startCampaignScheduler()` registers two intervals: a **recovery interval** (always: `recoverStuckCampaigns()` every tick, `checkForBounces()` every 5th) and a **send interval** (only when `emailPlatform==='none'`: `processDueSends()` every 60s). Constants: `POLL_INTERVAL_MS=60_000`, `BATCH_LIMIT=10`.

**`processDueSends()`:**
1. **Kill switch:** `EMAIL_SENDING_PAUSED_UNTIL` in future → skip whole tick.
2. **Pick due rows:**
   ```sql
   campaign_leads
     status='pending' AND channel='email'
     AND campaigns.status='sending'   -- via campaigns!inner join
     AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
   ORDER BY scheduled_at ASC LIMIT 10
   ```
   - **`!inner` is load-bearing** — without it Supabase left-joins, the status filter only narrows the nested object, and the 10 batch slots get burned on orphan rows from finalized campaigns (batch-starvation bug).
   - **`channel='email'`** excludes DM rows that have no `email_used`.
3. **Sender selection (campaign-level pin):** read `sending_schedule.senderAccountIds[]` (or legacy `senderAccountId`). `__env__` in the list → the env account is an eligible slot.
4. `buildSenderPool(pinnedIds)` + `loadSentCounts()`.
5. **Per-row loop:** `pickSender()` round-robins under-cap accounts; `undefined` (all capped) → `break` and defer to next tick. `sendScheduledEmail()`, then mutate in-memory `sentCounts` so rotation is fair within the tick. 2000ms pause between sends.
6. **Finalize** each touched `campaign_id` via `maybeFinalizeCampaign()`.

**`sendScheduledEmail(cl, account)` — the heart:**
1. **Atomic claim:** `UPDATE campaign_leads SET scheduled_at = now+10min WHERE id AND status='pending' AND scheduled_at = original RETURNING id`. Loser gets zero rows → bail. The 10-min push prevents re-selection mid-send and auto-retries a crashed send.
2. **Idempotency guard:** look for a `lead_notes` `email_sent` note for this campaign with no `step_number`. If found → flip to `sent` and return (no second send). Backstopped by migration-040 unique index.
3. **Render** subject + body with `renderAndSpin()` (tokens + spintax). *Initial scheduled sends do NOT call `applyTestMode`* (test-mode for initial sends is handled in `campaign-sender.ts`).
4. **Screenshot** resolution (http URL as-is, else local `.tmp/screenshots/<basename>`).
5. `sendEmail(...)`.
6. **On success:** `rateLimiter.recordSend()`; `UPDATE campaign_leads {status:'sent', sent_at, sender_email}`; if msg/thread id → `updateCampaignLeadGmailIds`; `updateLead {outreach_status:'contacted', contacted_at}`; `createNote {type:'email_sent', metadata:{campaign_id, gmail_message_id}}` (**no `step_number`** → marks initial). **On any UPDATE failure → retry minimal `{status:'sent'}`; if even that fails, log CRITICAL** (email sent but row stuck is exactly what caused repeat sends).

**`buildSenderPool(pinnedIds)`:** only when `emailMode==='gmail'`. Queries `email_accounts WHERE status='active' AND is_cold_sender=true AND auth_type IN ('gmail_oauth','smtp','app_password') [AND id IN pins]`. Per account computes `dailyCap = getRampedDailyCap(...)` and `hourlyCap = hourly_cap ?? config default`.

**`loadSentCounts()` — authoritative caps:** queries `campaign_leads (sender_email, sent_at) WHERE status='sent' AND sent_at >= now-24h`, buckets per lowercased `sender_email` into `{daily, hourly}`. This — not the in-memory rate-limiter — is what enforces per-account caps.

**`recoverStuckCampaigns()` / `maybeFinalizeCampaign()`:** a campaign finalizes (`status='sent', total_sent`) only when **zero `pending` rows with non-null `scheduled_at`** remain (deduped null-scheduled leads never send and must not stall finalization). On finalize, step-2 follow-ups are scheduled: `current_step=1, next_step_at = now + step2.delay_days*86400000` for all sent rows.

### 6.3 Follow-ups — `sequence-scheduler.ts`

`startSequenceScheduler()` (Gmail/direct mode only), `processDueFollowUps()` every 60s:
1. Same kill switch.
2. Select `campaign_leads (*, leads(*)) WHERE next_step_at <= NOW() AND sequence_completed=false AND sequence_paused=false LIMIT 20`.
3. Per row, `sendFollowUp()` with a 2000ms pause.

**`sendFollowUp(cl)`:**
1. **Atomic claim** by `next_step_at` (push 10 min).
2. **Idempotency guard** keyed on `step_number = nextStepNumber`.
3. **Reply pause:** if `status='replied'` → set `sequence_paused=true, next_step_at=null`, return.
4. Get the step from `campaign_steps`; none → `sequence_completed=true`.
5. `rateLimiter.waitUntilCanSend()` — **blocks** (polls 10s) here (campaign-scheduler defers instead).
6. **Subject threading:** prefix `Re: ` once if absent.
7. **Test mode:** follow-ups DO call `applyTestMode`.
8. **Sender reuse:** `getSenderAccountByEmail(cl.sender_email)` (strict: active + cold sender) → keeps the whole sequence on one inbox; falls back to env if null.
9. **Threading IDs:** for Gmail senders `inReplyTo=''` (Gmail's stored id is an opaque internal id, never an RFC822 Message-ID), `gmailThreadId=cl.gmail_thread_id`; for SMTP `inReplyTo=cl.gmail_message_id` (the real Message-ID). **All steps reference step-1's IDs and `gmail_message_id` is never overwritten.**
10. `sendEmail(...)`; on success advance `current_step`, recompute `next_step_at` from the next step, set `sequence_completed` when none remain, increment `campaigns.total_sent`, write `email_sent` note **with `step_number`**.

### 6.4 Caps & scheduling math

**`rate-limiter.ts`** has two independent systems:
- **Global `rateLimiter` singleton** (env-account only): in-memory rolling hourly/daily counters (reset on restart, intentional) + a DB-persisted warmup ramp (`email_warmup_state`). Hardcoded global ramp: days 1–3 → 10/day, 4–7 → 20, 8–14 → 30, 15–21 → 40, 22+ → `EMAIL_DAILY_CAP`. `canSend()`, `recordSend()`, `waitUntilCanSend()`. **What it actually gates:** `canSend()`/`waitUntilCanSend()` protect only the **env (`__env__`) sender slot** and the sequence-scheduler's blocking wait; `recordSend()` is still called on every send but only feeds these global counters + the warmup-state row. **Per-DB-account caps are NOT enforced here** — they come from `loadSentCounts` (real history) below.
- **`getRampedDailyCap(account)`** (pure, per-DB-account): no `warmup_started_at` → `daily_cap ?? env`. Else `dayN = floor((now-start)/86.4e6)+1`; if `dayN >= max(2, rampDays)` → `target`; else linear ramp from a floor of 10 up to target. **DB-account caps are enforced from real `campaign_leads.sent_at` history (`loadSentCounts`), not the in-memory counter.**

**`schedule-engine.ts`** — `assignScheduledTimes(count, schedule, fromNow?)`: parses the local-timezone window (DST-correct via `Intl.DateTimeFormat`), supports overnight windows, throws on zero-length window / empty `days` / `dailyLimit<=0`. Walks days, skips disallowed/closed days, fills `min(remaining, dailyLimit)` per day, divides the window into segments and picks a **uniformly random minute per segment** (deliberately non-cron-looking, ~20-min ideal gap shrinking to 2-min minimum). Returns sorted `Date[]`; may return fewer than `count` if the window is too narrow.

**`test-mode.ts`** — `applyTestMode(email, override?, testEmailOverride?)`: when on, redirect `to` → test address(es) and prefix subject `Test mode- `. Applied **once upstream** — the sender facade never re-applies it.

### 6.5 Live-send entry — `campaign-sender.ts`

`runCampaignSend({campaignId, campaignName, emails, sendingSchedule?, testMode?, testEmailOverride?})` (fire-and-forget):
1. Set campaign `status='sending'`; emit `started`.
2. **TEST mode:** send everything immediately (honoring `cancelRequests`), `applyTestMode`, finalize.
3. **LIVE, no schedule:** spread over a 1–30 min window, write `scheduled_at`, emit `scheduled`.
4. **LIVE, with schedule:** `assignScheduledTimes()` → write each `scheduled_at` → emit `scheduled`. **Status stays `sending`; the campaign-scheduler finalizes.**
5. Errors reset to `draft`.

`campaignEvents` (EventEmitter) emits `progress` events consumed by the SSE route. `cancelCampaign(id)` is honored only inside the TEST loop.

### 6.6 Duplicate-send watchdog — `duplicate-send-monitor.ts`

Defense-in-depth above the claim locks + unique indexes. Every `DUPLICATE_SEND_MONITOR_INTERVAL_MS` (default 5 min), groups `email_sent` notes in the last `WINDOW_MIN` by `lead_id|campaign_id|step_number`; any tuple with >1 → alert via Slack-style webhook and/or email (using `getAccountForUtilitySend(FROM_EMAIL)`), with a 1-hour per-tuple cooldown. The alert email includes the literal `EMAIL_SENDING_PAUSED_UNTIL` gcloud kill-switch command. No-op unless EMAIL or WEBHOOK is configured.

### 6.7 Helper modules — `sender-loader.ts` & `sender-dns-gate.ts`

Two small must-port files the pipeline leans on:

**`sender-loader.ts`** — maps an `email_accounts` row → a `SenderAccount` and loads one sender by email. `mapRow()` computes `dailyCap = getRampedDailyCap(...)`, `hourlyCap = hourly_cap ?? config default`, then returns the SMTP shape (if `auth_type='smtp'` + smtp creds), the Gmail shape (if `gmail_oauth`/`app_password` + **gmail OAuth creds** — see the §4.2 quirk), or `null`. Two loaders:
- `getSenderAccountByEmail(email)` — **strict**: `status='active' AND is_cold_sender=true AND ilike(email) AND auth_type IN ('gmail_oauth','smtp','app_password')`. Null → caller falls back to the env sender. Used by `sequence-scheduler` to keep a whole sequence on the inbox that sent step 1.
- `getAccountForUtilitySend(email)` — **loose**: drops the `status='active'` and `is_cold_sender` filters (a paused mailbox should not silence the monitor that watches for pauses; warmup peers may send utility mail). Still requires full creds. Used by the duplicate-send monitor and colleague warmup. **Don't swap the two** (§13.6).

**`sender-dns-gate.ts`** — `gateSendersByDns(pinnedAccountIds)` → `{ok, checked, skipped, failures[]}`. Strips `__env__`/empty ids; for each remaining **SMTP** account (Gmail/app-password skipped — Google owns their DNS) reads the cached `dns_mx/spf/dmarc/dkim` booleans, and if `dns_checked_at` is older than `DNS_CACHE_TTL_MS = 6h` (or null) runs a live `checkDomainHealth(domain)` and writes the refreshed values back. Any of MX/SPF/DMARC/DKIM false → a failure. `formatGateError(result)` renders a one-line copy-paste 400-response message. Called at `/preview` and `/send` (§11.1) only when senders are pinned; gracefully falls back to a select without `dns_dkim` if migration 035 hasn't run.

---

## 7. Templating & Personalization

### 7.1 Template engine — `template-engine.ts`

Two-phase: **token substitution first, spintax second** (`renderAndSpin = renderTemplate → resolveSpintax`).

- **Token syntax:** `{{word}}` (regex `/\{\{(\w+)\}\}/g`). Unknown tokens ship verbatim.
- **Supported tokens** (resolved from the `leads` row; fallbacks chosen to avoid spam-signal gaps like "with a -star rating"):

  | Token | Source | Fallback |
  |---|---|---|
  | `{{company_name}}` | `company_name` (auto-capitalized) | `your team` |
  | `{{website_url}}` | `website_url` | `your website` |
  | `{{star_rating}}` | `star_rating` | `below-average` |
  | `{{review_count}}` | `review_count` | `your` |
  | `{{category}}` | `category` | `your industry` |
  | `{{country}}` | `country` | `your market` |
  | `{{email}}` | `primary_email` | `''` |
  | `{{post_excerpt}}` | `post_excerpt` | `your recent post` |
  | `{{post_url}}` | `post_url` | `''` |

  > Caveat: `post_excerpt`/`post_url` are aspirational — the current send path passes the bare `leads (*)` row and does **not** join `lead_platform_posts`, so they hit fallbacks unless the lead row itself carries them.

- **Placeholder stripping:** after tokens, `stripSenderPlaceholders()` removes LLM artifacts (`[Your Name]`, `[Your Company]`, `[Signature]`, `[Sender]`, …) and substitutes `EMAIL_FROM_NAME` (default `OptiRate`).
- **No HTML sanitization** in the engine — templates are operator-authored. HTML wrapping/`ensureHtml` and the plain-text alternative happen in the sender modules. There is no DOMPurify equivalent.

### 7.2 Spintax — `spintax.ts`

`resolveSpintax(text)`: iteratively resolves the **innermost** `{a|b|c}` group (regex `/\{([^{}]+)\}/`), replacing the first occurrence with a uniformly random option, up to **500 iterations** (AI templates nest deeply). Nesting is handled by innermost-first resolution (`{Hi|{Hey|Howdy} there}`). Randomness is `Math.random()` (per-recipient variation). A final `replace(/[{}]/g,'')` strips any surviving stray braces so malformed templates never leak merge artifacts.

### 7.3 Warmup (two independent subsystems)

**A) In-pool warmup — `warmup-scheduler.ts` + `warmup-templates.ts`.** Simulates natural two-way conversations among *your own* connected mailboxes across ISPs. Pool = `email_accounts` with `warmup_enabled=true, status='active'` and full creds (≥2 needed). A 4-stage state machine in `warmup_emails` (`pending_open → pending_reply → pending_read → complete`), advanced every 10 min, with **5–30 min random delays** between stages. Uses 15 hardcoded business-conversation templates with subject/body/replyBody, an 8-char `warmup_uid` embedded in the subject for IMAP/Gmail lookup, and marks messages read/important + replies threaded. Per-account daily target = `warmup_daily_target` (default 5).

**B) Colleague warmup — `colleague-warmup/`.** A ~3-week reputation-rehab tool (in-memory state only) that sends neutral admin-style emails from the cold senders to a fixed colleague list; **humans manually reply/forward** (no open/reply automation). Key differences: **deliberately ignores `EMAIL_SENDING_PAUSED_UNTIL`** (its own switch is `COLLEAGUE_WARMUP_ENABLED`), uses the production `sendEmail` path via `getAccountForUtilitySend` (so a paused mailbox still warms). Ramp (`ramp.ts`): counts Mon–Fri workdays from `COLLEAGUE_WARMUP_START_DATE`; per sender day-1 = 5/day, +1 each workday, plateau 20. Planner (`plan.ts`) is pure: Fisher-Yates shuffles recipients per sender, jitters sends 45–50 min apart inside a Manila 3pm–10pm window, and emails a daily preview to a coordinator.

---

## 8. Reply Tracking (inbound)

One `setInterval` (10 min) runs both pollers in sequence; also exposed at `POST /api/gmail/check-replies`.

### 8.1 Gmail path — `reply-tracker.ts`
Gated on `EMAIL_MODE=gmail`. Loads `campaign_leads WHERE status='sent' AND gmail_thread_id IS NOT NULL`, fetches the full thread, and the reply is the first message whose `From` isn't the sender. Gmail's own `thread_id` does the grouping — no header matching needed.

### 8.2 IMAP path — `reply-tracker.imap.ts`
Provider-agnostic (the better template for reuse). For each `auth_type='smtp', status='active'` account, locks INBOX, `SEARCH SINCE last-7-days`, and matches each message via **three strategies, first hit wins**:
1. **`from`** — envelope From == `email_used`
2. **`in-reply-to`** — normalized `In-Reply-To` matches an outgoing Message-ID (`leadByMessageId`)
3. **`references`** — any `<...>` in the `References` header matches an outgoing Message-ID

(2 + 3 catch helpdesk/ticketing systems whose visible From is a ticket address.) All accounts polled concurrently via `Promise.allSettled` + `withTimeout(240s)` so one stalled server can't starve the loop.

### 8.3 Classification — `auto-reply-detector.ts` (pure, IO-free)
`classifyReply({headers, subject, body})` → `{kind:'human'|'auto'|'ticket', confidence, signals}`. Accumulates an auto-confidence score from RFC-3834 headers (`Auto-Submitted`, `X-Autoreply`, `Precedence:bulk`…), ticket headers (`X-Zendesk-Ticket`, `X-Freshdesk-Id`…), subject regexes (OOO in EN/DE/FR/NL), and body regexes ("do not reply", "out of office"…). Verdict: ticket header → `ticket`; else `confidence >= 0.4` → `auto`; else `human`.

### 8.4 Status updates
- **Human reply:** `campaign_leads.status='replied'`, `replied_at`, `reply_snippet`; `leads.outreach_status='replied'`; `lead_notes type='email_replied'`; `campaigns.total_replied++`.
- **Auto reply** (when `AUTO_REPLY_HANDLING_ENABLED`): `status='auto_replied'`; **`leads.outreach_status` stays `contacted`** (a machine answered — kept out of the human reply-rate); `campaigns.total_auto_replied++`; `lead_notes type='auto_reply_received'`. Then **contact discovery** (`auto-reply-extractor.ts`): pulls candidate emails/URLs, ranks by role (affiliate/partner = 10 … generic contact = 3), filters out the echoed recipient, your own/same-domain addresses, noreply/postmaster, free-mailbox, and tracking domains; persists to `discovered_contacts`. If zero candidates → writes `auto_reply_no_contacts` and bails (credit saver). URLs queued only when `AUTO_QUEUE_URLS_FROM_REPLIES`.

### 8.5 On-demand body fetchers
`imap-reply-fetcher.ts` / `gmail-reply-fetcher.ts` / `imap-thread-fetcher.ts` back the Inbox UI when an old `replied` row has an empty snippet — reconstruct the full thread from RFC822 headers, with a 60s cache and `dedupBurstDuplicates` (collapses same-direction sends within 5 min, defending against the scheduler-race duplicates).

---

## 9. Email Verification Cascade

The order lives in **`email-validator/index.ts` → `validateEmail(email, opts)`** (the three provider files are leaf adapters). `FinalStatus = 'valid'|'invalid'|'catch-all'|'unknown'`. Short-circuits on the first definitive verdict.

| Stage | Check | Cost | Terminal verdicts | Escalates on |
|---|---|---|---|---|
| 1 | Syntax | free | `invalid` | pass |
| 2 | DNS/MX | free | `invalid` (no MX) | has MX |
| 3 | Catch-all probe (per-domain, cached 7d in `domain_intel`; skips Google Workspace/Outlook365 which 250 everything) | free | `catch-all` | not catch-all |
| 4 | SMTP RCPT-TO probe | free | `valid` (250) / `invalid` (550) | non-definitive |
| 5 | **ZeroBounce** (`/v2/validatebatch`, 100-batch) | paid | valid/invalid/catch-all | `unknown` |
| 6 | **MillionVerifier** (`/api/v3/`) | paid | valid/invalid/catch-all | `unknown` |
| 7 | **Hunter.io** (`/v2/email-verifier`) | paid | valid/invalid/catch-all | `unknown` → fall through to `unknown` |

Escalation trigger is always a non-definitive `unknown` (a provider returning null — missing key, rate cap, error — is treated as "no verdict, keep going"). The free stages resolve most addresses; paid tiers are credit-guarded (Hunter has `HUNTER_MAX_CALLS_PER_HOUR` default 20 + free-mailbox skip).

**Verdict mapping highlights:** ZeroBounce `spamtrap/abuse→invalid`, `do_not_mail`→invalid or catch-all by sub-status, `toxic→unknown`. MillionVerifier `ok→valid, catch_all→catch-all, disposable→unknown`. Hunter `accept_all→catch-all, valid+deliverable→valid`, everything risky/webmail/unknown→`unknown` (never silently upgrades).

**Landing the verdict** (`routes/verify.ts`): `POST /api/verify` (async job, SSE progress) writes `leads.verification_status`, `email_verified=(status==='valid')`, `verified_at`, per-source `*_email_status` columns, and a `verification` note. `POST /api/verify/sync` (≤5 leads) also recomputes `primary_email`.

---

## 10. Bounce Handling — `bounce-tracker.ts`

`checkForBounces()` runs every 5th campaign-scheduler tick (~5 min) and at `POST /api/gmail/check-bounces`. **Gmail-only** (`EMAIL_MODE=gmail`). Scans connected Gmail inboxes for `from:mailer-daemon is:unread newer_than:30d`, extracts the bounced address (5 regexes), classifies hard (550/551/552/5.1.x/"user unknown") vs soft (4xx/"mailbox full"), **defaulting to hard**. For each matching `campaign_leads` (`email_used` match, status in pending/sent/opened): set `status='bounced'`, `campaigns.total_bounced++`, write `email_bounced` note. **Hard bounce additionally** sets `leads.email_verified=false, verification_status='invalid'` (excludes from future campaigns + the invalid-email send gate). Marks the DSN read so it isn't reprocessed. **A bounce never pauses the account** — only `EMAIL_SENDING_PAUSED_UNTIL`, caps, and DNS status govern account availability.

---

## 11. API Routes — `routes/campaigns.ts` (`/api/campaigns`)

Responses: `{success:true, data}` / `{success:false, error}`. Literal paths declared before `/:id`.

| Method + Path | Purpose |
|---|---|
| `GET /` | List campaigns + live-computed stats. |
| `POST /` | Create campaign (+ `campaign_steps` from `followUpSteps`). `MAX_CAMPAIGN_RECIPIENTS=5000`. Validates manual emails, upserts them as leads. |
| `GET /config/mode` | `{manualLeadsOnly, testMode, emailPlatform, emailMode}`. |
| `GET /preview-recipients?country&category` | `{count, sample[]}` (leads with non-null `primary_email`). |
| `GET /sent-emails` | Global "already contacted" lowercased set. |
| `GET /rate-limit` / `GET /warmup-status` | Rate-limiter + warmup status. |
| `PATCH /:id` / `DELETE /:id` | Update / delete. |
| `POST /:id/test-flight` | **Mandatory pre-flight** (§10.3 below). Body `{testEmail}`. |
| `POST /:id/send` | Live-send gate chain (§11.1). Body `{testMode?, testEmail?, limit?}`. |
| `GET /:id/send/status` | SSE stream of `campaignEvents`. |
| `POST /:id/cancel` | Set `status='draft'` (scheduler re-checks status each send). |
| `POST /:id/sync` | `syncSingleCampaign` + fresh stats. |
| `GET /:id/stats` / `GET /:id/leads` / `POST /:id/leads` | Stats / list / add leads. |
| `POST /:id/duplicate` | Clone (copies steps). |
| `GET /:id/steps` | Follow-up steps. |
| `GET /platform-status` | External-platform health. |

### 11.1 `POST /:id/send` gate chain
1. Load leads (400 if none) + campaign (404).
2. Manual-only mode check.
3. **Dedup:** `getSentEmails()` (sent/opened/replied/auto_replied/bounced); pending rows whose `email_used` is already contacted → `status='skipped'`, `skip_reason='already_contacted_in_another_campaign'`, filtered out.
4. **Invalid-email gate:** 400 if any pending lead is `verification_status='invalid'` (catch-all/unknown pass with a warning chip).
5. **DNS gate:** `gateSendersByDns(pinnedIds)` — for each pinned **SMTP** sender, read cached `dns_*` (refresh if older than 6h via live lookup); any of MX/SPF/DMARC/DKIM false → 400 with a `dnsGate` payload. Gmail/app-password/env skipped (Google owns their DNS).
6. **Platform mode** → `pushCampaignToPlatform`. **Direct mode** → build per-email payloads (`renderAndSpin`) → `runCampaignSend(...)` fire-and-forget.

### 11.2 Webhooks — `routes/webhooks.ts`
`POST /api/webhooks/email-platform`: HMAC-SHA256 verification (`x-webhook-signature`/`x-hub-signature-256`) with static-secret fallback, constant-time compare. Normalizes the payload, maps `email_sent/opened/replied/bounced` to status (won't downgrade except always-apply `bounced`), updates `campaign_leads` + `leads.outreach_status`, writes an activity note. Always returns 200 (prevents retries). Only relevant in platform mode.

### 11.3 Mandatory test flight
`POST /:id/test-flight` picks the first pending lead with a real `email_used` (for authentic token values), runs the same DNS gate, renders with `renderAndSpin`, resolves the pinned sender (SMTP/Gmail/app-password, env fallback), wraps via `applyTestMode(..., true, testEmail)`, and sends one email. **It does not touch the DB or fire the async sender.** The gate is **UI-enforced**: the campaign card's launch path opens a choice modal — "Send Test Email First" (→ `TestFlightModal`) or "Go Live Now" (behind a JS `confirm()`). The API `/send` does not require a prior test flight.

---

## 12. Frontend — Campaign Wizard

> The shipped wizard is **4 steps** (`WizardStep1Leads` / `WizardStep2Sequence` / `WizardStep3Options` / `WizardStep4Launch`) + `scheduleConfig.ts`, orchestrated by `CampaignWizard.tsx`. The older `StepSetup/StepTemplate/StepFollowUps/StepRecipients/StepReview` files are **dead code** — don't port them. (The test flight is the conceptual "5th step.")

1. **Step 1 — Select Leads:** matrix mode (platform/country/category dropdowns from `GET /leads/filters`, `maxLeads` 1–5000, paginated lead table) or manual mode (one email/line, regex-validated). "Select page" only auto-adds `verification_status==='valid'` leads; clicking an `invalid` row triggers `POST /verify/sync`.
2. **Step 2 — Sequence:** subject + HTML body editor with token buttons + spintax, "Generate with AI" (Gemini, language from country). Follow-ups: `addFollowUp()` appends `{delayDays, subject, body}` (first delay 3, +3 each); auto-translates for non-English targets. Screenshot toggle (intro step only).
3. **Step 3 — Options:** campaign name; sending accounts (`GET /email-accounts?role=sender`, multi-select → `schedule.senderAccountIds[]`); sending schedule controls.
4. **Step 4 — Launch:** read-only review + pre-launch checklist; "Create Campaign" makes a **draft** (no send). Directs the user to test-flight before going live.

**`SendingSchedule` type (`scheduleConfig.ts`):**
```ts
interface SendingSchedule {
  timezone: string;          // IANA
  startHour: string;         // 'HH:MM'
  endHour: string;           // 'HH:MM'
  days: number[];            // 0=Sun … 6=Sat
  dailyLimit: number;
  senderAccountIds?: string[]; // '__env__' or DB uuids (rotation pool)
  senderAccountId?: string;    // @deprecated
}
// DEFAULT_SCHEDULE = { timezone:'Asia/Manila', startHour:'09:00', endHour:'17:00', days:[1,2,3,4,5], dailyLimit:50 }
```

**`useCampaigns.ts` hook** calls: `GET /campaigns`, `POST /campaigns`, `POST /:id/send`, `POST /:id/cancel`, `DELETE /:id`, `POST /:id/leads`, `GET /:id/leads`, `GET /inbox/thread/:id`, `POST /gmail/check-replies`, `GET /gmail/rate-limit`, `POST /:id/test-flight`, `GET /campaigns/warmup-status`, `POST /:id/duplicate`, `GET /campaigns/preview-recipients`, `POST /:id/sync`, `GET /campaigns/platform-status`, `GET /:id/steps`.

---

## 13. Invariants — Do Not Break When Reusing

1. **`campaigns!inner` + `.eq('campaigns.status','sending')`** in `processDueSends` — removing `!inner` reintroduces batch-starvation.
2. **Atomic claim pattern** (conditional UPDATE by time column, push 10 min out) is the only thing preventing concurrent/cross-tick double-sends. Both schedulers depend on Postgres row-locking the UPDATE.
3. **`lead_notes` idempotency convention:** initial sends → note with **no `step_number`**; follow-ups → with `step_number`. Migration-040 unique partial indexes and the duplicate monitor key off this exact convention.
4. **Per-account caps come from real `campaign_leads.sent_at` history** (`loadSentCounts`), not the in-memory rate-limiter (which is env-account only and resets on restart).
5. **Follow-ups thread on step-1's IDs and never overwrite `gmail_message_id`/`gmail_thread_id`.** Never use a Gmail internal id as `In-Reply-To` (SMTP only).
6. **Sender reuse:** `getSenderAccountByEmail` is strict (active + cold sender); `getAccountForUtilitySend` is intentionally loose (for warmup/monitor utility sends). Don't swap them.
7. **Post-send UPDATE must succeed or fall back to minimal `status='sent'`** — leaving a row claimed with the email already sent is exactly what caused the repeat-send incident.
8. **`SCHEDULERS_ENABLED=false` on autoscaled instances** — run schedulers on one dedicated `min=max=1` instance. N replicas = N parallel schedulers racing the same rows.
9. **Test mode is applied once upstream**, never re-applied in the facade. Initial scheduled sends apply it in `campaign-sender.ts`; follow-ups apply it in `sequence-scheduler.ts`; the campaign-scheduler's initial path does not.

---

## 14. Reuse Checklist (porting to another project)

- [ ] Create the tables. **Copy-paste DDL is in Appendix A.** Partitioned by concern so you only take what you need:
  - **Sending core (always):** `campaigns`, `campaign_leads`, `campaign_steps`, `email_accounts`, `lead_notes` (+ its two unique partial indexes), your recipient/`leads` table.
  - **Warmup only:** `email_warmup_state`, `warmup_emails`.
  - **Verification only:** `domain_intel` (catch-all cache).
  - **Reply discovery only:** `discovered_contacts` (+ `leads.discovered_email*` columns).
  - **CRM reminders (optional):** `follow_ups`.
- [ ] Port the sender facade + the provider modules you need (`email-sender.ts` + gmail/smtp/brevo/mock). Keep `SendEmailOptions`/`SendEmailResult`/`SenderAccount` shapes.
- [ ] Port `campaign-scheduler.ts`, `sequence-scheduler.ts`, `campaign-sender.ts`, `sender-loader.ts`, `sender-dns-gate.ts`, `rate-limiter.ts`, `schedule-engine.ts`, `test-mode.ts`, `template-engine.ts`, `spintax.ts`. These are largely framework-agnostic.
- [ ] Wire the `setInterval` bootstrap (§6.1) with the `SCHEDULERS_ENABLED` gate and the orphaned-campaign reset.
- [ ] **Encrypt the email credential columns** with the GCM helper (they ship plaintext today — §4.5).
- [ ] Parameterize the OptiRate-specific bits: `EMAIL_FROM_NAME` brand, `SMTP_PROBE_HELO`/`SMTP_PROBE_FROM`, the role-score table in `auto-reply-extractor.ts`, the sender-domain denylist, the colleague-warmup recipient/subject lists and Manila timezone window, and the `trustpilot-screenshot` CID/filename.
- [ ] Set the env vars in §2. At minimum: `EMAIL_PLATFORM=none`, `EMAIL_MODE`, Supabase keys, `EMAIL_TEST_MODE=true` + `TEST_EMAIL_ADDRESS` while testing, and provider creds per account row.
- [ ] Reproduce the UI test-flight gate (§10.3) if you want the "no live send without a test" guarantee — it's not enforced server-side.
- [ ] Verify deliverability prerequisites: MX + SPF + DMARC (+ DKIM) on every sending domain; warm each account from 10–20/day ramping over 2–4 weeks.
- [ ] Install runtime deps: `googleapis` (Gmail OAuth/API), `nodemailer` (SMTP send + `MailComposer` MIME build), `imapflow` (IMAP Sent-append + reply polling), `mailparser` (`simpleParser` for inbound bodies), and the Supabase JS client. Postgres needs the `pgcrypto` extension (for `gen_random_uuid()`). Node 20+ is assumed for ICU-backed `Intl.DateTimeFormat` (the schedule engine relies on it for DST-correct timezone math).

### Deployment note (scheduler topology)
The single-scheduler-instance rule (§13.8) is intentionally left as *intent* here because the recipe is stack-specific. On Cloud Run it means: deploy the same image twice — the public autoscaled service with `SCHEDULERS_ENABLED=false`, and a second service (or revision) with `--min-instances=1 --max-instances=1` and `SCHEDULERS_ENABLED=true` that takes no public traffic. On a VM/container stack, run exactly one process with the schedulers enabled. The hard requirement is simply: **never run the campaign/sequence schedulers on more than one process at a time.**

---

## 15. File Map

**Schedulers / pipeline:** `server/src/services/campaign-scheduler.ts`, `sequence-scheduler.ts`, `campaign-sender.ts`, `sender-loader.ts`, `sender-dns-gate.ts`, `rate-limiter.ts`, `schedule-engine.ts`, `test-mode.ts`, `duplicate-send-monitor.ts`, `server.ts` (bootstrap).
**Senders:** `email-sender.ts`, `email-sender.gmail.ts`, `email-sender.smtp.ts`, `email-sender.brevo.ts`, `email-sender.mock.ts`, `gmail-client.ts`.
**Templating / warmup:** `template-engine.ts`, `spintax.ts`, `warmup-scheduler.ts`, `warmup-templates.ts`, `colleague-warmup/*`.
**Inbound / verify:** `reply-tracker.ts`, `reply-tracker.imap.ts`, `imap-reply-fetcher.ts`, `imap-thread-fetcher.ts`, `gmail-reply-fetcher.ts`, `auto-reply-detector.ts`, `auto-reply-extractor.ts`, `bounce-tracker.ts`, `email-verifier.{zerobounce,millionverifier,hunter}.ts`, `email-validator/index.ts`, `email-validator/dns-check.ts`, `dns-checker.ts`.
**Routes / DB:** `routes/campaigns.ts`, `routes/webhooks.ts`, `routes/email-accounts.ts`, `routes/verify.ts`, `db/campaigns.ts`, `db/campaign-steps.ts`, `lib/encryption.ts`.
**Frontend:** `components/campaign-wizard/{CampaignWizard,WizardStep1Leads,WizardStep2Sequence,WizardStep3Options,WizardStep4Launch,scheduleConfig}.tsx`, `components/TestFlightModal.tsx`, `views/Campaigns.tsx`, `hooks/useCampaigns.ts`.
**Migrations:** `supabase/migrations/` 001, 003, 005, 006, 007, 008, 009, 010, 011, 012, 013, 016, 017, 023, 028, 035, 038, 039, 040.

---

## Appendix A — Consolidated DDL (copy-paste)

Final-state `CREATE TABLE` SQL for the email subsystem, merged across all 19 relevant migrations into one runnable script. Dependency-ordered. The `leads` block is a prerequisite (every other table FKs to it) — **delete it if you already create `leads` elsewhere**; it includes only the columns the email/templating/auto-reply paths read. Warmup/verification/discovery tables are clearly sectioned so you can drop the ones you don't need (see the §14 partition).

```sql
-- ============================================================
-- CONSOLIDATED FINAL-STATE DDL — Email-Sending Subsystem
-- Merged from migrations 001, 003, 005, 006, 007, 008, 009,
-- 010, 011, 012, 013, 016, 017, 023, 028, 035, 038, 039, 040.
-- Dependency order: leads → campaigns → campaign_leads/steps;
-- email_accounts / email_warmup_state / warmup_emails standalone;
-- lead_notes / follow_ups reference leads.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------- PREREQUISITE: leads (delete if created elsewhere) ----------
-- Email system reads: id, company_name, website_url, primary_email,
-- screenshot_path, outreach_status, verification_status, email_verified,
-- and (since 028) discovered_email / discovered_email_status / discovered_email_source.
CREATE TABLE IF NOT EXISTS leads (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name             text NOT NULL,
  trustpilot_url           text UNIQUE NOT NULL,    -- legacy unique key; rename/relax for your platform
  website_url              text,
  trustpilot_email         text,
  website_email            text,
  primary_email            text,
  phone                    text,
  country                  text,
  category                 text,
  star_rating              real,
  email_verified           boolean DEFAULT false,
  verification_status      text DEFAULT 'unknown'
    CHECK (verification_status IN ('valid', 'invalid', 'catch-all', 'unknown')),
  outreach_status          text DEFAULT 'new'
    CHECK (outreach_status IN ('new', 'contacted', 'replied', 'converted', 'lost')),
  screenshot_path          text,
  lead_source              text DEFAULT 'trustpilot_scrape',
  scraped_at               timestamptz,
  contacted_at             timestamptz,
  discovered_email         text,   -- since 028
  discovered_email_status  text,   -- since 028
  discovered_email_source  jsonb,  -- since 028
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_outreach_status ON leads (outreach_status);
CREATE INDEX IF NOT EXISTS idx_leads_country_category ON leads (country, category);
CREATE TRIGGER leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------- 1. campaigns ----------
CREATE TABLE IF NOT EXISTS campaigns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  template_subject     text,
  template_body        text,
  status               text DEFAULT 'draft',
  include_screenshot   boolean DEFAULT false,
  total_sent           int DEFAULT 0,
  total_opened         int DEFAULT 0,
  total_replied        int DEFAULT 0,
  total_bounced        int DEFAULT 0,
  sent_at              timestamptz,
  filter_country       text,                     -- since 005
  filter_category      text,                     -- since 005
  platform_campaign_id text,                     -- since 006
  email_platform       text,                     -- since 006
  sending_schedule     jsonb,                    -- since 008
  total_auto_replied   integer DEFAULT 0,        -- since 028
  campaign_type        text DEFAULT 'outreach',  -- since 028
  parent_campaign_id   uuid,                     -- since 028
  created_at           timestamptz DEFAULT now(),
  CONSTRAINT campaigns_status_check
    CHECK (status IN ('draft', 'sending', 'sent', 'completed')),
  CONSTRAINT campaigns_campaign_type_check
    CHECK (campaign_type IN ('outreach', 'discovery_followup')),
  CONSTRAINT campaigns_parent_campaign_id_fkey
    FOREIGN KEY (parent_campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_platform_active
  ON campaigns (email_platform)
  WHERE platform_campaign_id IS NOT NULL AND status IN ('sending', 'active');

-- ---------- 2. campaign_leads (the queue) ----------
CREATE TABLE IF NOT EXISTS campaign_leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id            uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  email_used         text,
  status             text DEFAULT 'pending',
  sent_at            timestamptz,
  opened_at          timestamptz,
  replied_at         timestamptz,
  bounced_at         timestamptz,
  gmail_message_id   text,                          -- since 003 (SMTP reuses this for its RFC822 Message-ID)
  gmail_thread_id    text,                          -- since 003
  reply_snippet      text,                          -- since 005
  platform_lead_id   text,                          -- since 006
  current_step       int DEFAULT 1,                 -- since 007
  next_step_at       timestamptz,                   -- since 007
  sequence_completed boolean DEFAULT false,         -- since 007
  sequence_paused    boolean DEFAULT false,         -- since 007
  scheduled_at       timestamptz,                   -- since 011
  sender_email       text,                          -- since 016
  reply_read_at      timestamptz,                   -- since 017
  skip_reason        text,                          -- since 038
  channel            text NOT NULL DEFAULT 'email', -- since 039
  CONSTRAINT campaign_leads_status_check
    CHECK (status IN ('pending','sent','opened','replied','bounced','auto_replied','skipped')),
  CONSTRAINT campaign_leads_channel_check
    CHECK (channel IN ('email','dm_facebook','dm_instagram')),
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign ON campaign_leads (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_lead     ON campaign_leads (lead_id);
CREATE INDEX IF NOT EXISTS idx_cl_gmail_thread  ON campaign_leads (gmail_thread_id)  WHERE gmail_thread_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cl_gmail_message ON campaign_leads (gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cl_platform_lookup ON campaign_leads (email_used, campaign_id) WHERE email_used IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cl_next_step_due ON campaign_leads (next_step_at)
  WHERE next_step_at IS NOT NULL AND sequence_completed = false AND sequence_paused = false;
CREATE INDEX IF NOT EXISTS idx_campaign_leads_scheduled_at ON campaign_leads (scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS campaign_leads_sender_sent_at_idx ON campaign_leads (sender_email, sent_at DESC)
  WHERE sender_email IS NOT NULL AND sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cl_unread_replies ON campaign_leads (replied_at DESC)
  WHERE status = 'replied' AND reply_read_at IS NULL;

-- ---------- 3. campaign_steps ----------
CREATE TABLE IF NOT EXISTS campaign_steps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_number      int  NOT NULL DEFAULT 1,
  delay_days       int  NOT NULL DEFAULT 0,
  template_subject text NOT NULL,
  template_body    text NOT NULL,
  created_at       timestamptz DEFAULT now(),
  UNIQUE (campaign_id, step_number)
);
CREATE INDEX IF NOT EXISTS idx_cs_campaign ON campaign_steps (campaign_id);

-- ---------- 4. email_accounts (sender mailboxes) ----------
CREATE TABLE IF NOT EXISTS email_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL UNIQUE,
  from_name           text NOT NULL,
  provider            text NOT NULL DEFAULT 'smtp',
  smtp_host           text,
  smtp_port           integer,
  smtp_user           text,
  smtp_password       text,        -- ⚠️ plaintext today — encrypt on reuse (§4.5)
  status              text NOT NULL DEFAULT 'active',
  notes               text,
  auth_type           text NOT NULL DEFAULT 'smtp',   -- since 010
  app_password        text,                            -- since 010 (plaintext)
  gmail_client_id     text,                            -- since 010
  gmail_client_secret text,                            -- since 010 (plaintext)
  gmail_refresh_token text,                            -- since 010 (plaintext)
  smtp_secure         text NOT NULL DEFAULT 'tls',     -- since 010 ('tls'|'ssl'|'none')
  warmup_enabled      boolean NOT NULL DEFAULT false,  -- since 012
  warmup_daily_target integer NOT NULL DEFAULT 5,      -- since 012
  imap_host           text,                            -- since 013
  imap_port           integer,                         -- since 013
  imap_user           text,                            -- since 013
  imap_pass           text,                            -- since 013 (plaintext)
  email_provider      text NOT NULL DEFAULT 'gmail',   -- since 013
  daily_cap           integer,                         -- since 016
  hourly_cap          integer,                         -- since 016
  dns_mx              boolean,                          -- since 016
  dns_spf             boolean,                          -- since 016
  dns_dmarc           boolean,                          -- since 016
  dns_checked_at      timestamptz,                      -- since 016
  is_cold_sender      boolean NOT NULL DEFAULT true,   -- since 023
  warmup_started_at   timestamptz,                      -- since 023
  warmup_target_cap   integer NOT NULL DEFAULT 50,     -- since 023
  warmup_ramp_days    integer NOT NULL DEFAULT 21,     -- since 023
  dns_dkim            boolean,                          -- since 035
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_accounts_cold_sender_idx
  ON email_accounts (is_cold_sender, status) WHERE is_cold_sender = true;
ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON email_accounts FOR ALL USING (true);

-- ---------- 5. email_warmup_state (WARMUP ONLY) ----------
CREATE TABLE IF NOT EXISTS email_warmup_state (
  account_email  text        PRIMARY KEY,
  start_date     timestamptz NOT NULL DEFAULT now(),
  lifetime_sent  integer     NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- 6. warmup_emails (WARMUP ONLY) ----------
CREATE TABLE IF NOT EXISTS warmup_emails (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account     text        NOT NULL,
  to_account       text        NOT NULL,
  subject          text        NOT NULL,
  body             text        NOT NULL,
  warmup_uid       text        NOT NULL UNIQUE,
  gmail_message_id text,
  gmail_thread_id  text,
  reply_body       text,
  stage            text        NOT NULL DEFAULT 'pending_open',
  -- stages: pending_open -> pending_reply -> pending_read -> complete | failed (no CHECK in source)
  process_after    timestamptz NOT NULL,
  sent_at          timestamptz NOT NULL DEFAULT now(),
  opened_at        timestamptz,
  replied_at       timestamptz,
  reply_read_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warmup_emails_stage_process
  ON warmup_emails (stage, process_after) WHERE stage NOT IN ('complete', 'failed');

-- ---------- 7. lead_notes (+ send-idempotency indexes) ----------
CREATE TABLE IF NOT EXISTS lead_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type        text NOT NULL,
  content     text,
  metadata    jsonb DEFAULT '{}',
  created_at  timestamptz DEFAULT now(),
  CONSTRAINT lead_notes_type_check CHECK (type IN (
    'note','status_change','email_sent','email_opened','email_replied','email_bounced',
    'call','follow_up','verification',
    'auto_reply_received','auto_reply_no_contacts','auto_reply_candidate',
    'discovered_contact_accepted','discovered_contact_dismissed','lead_spawned_from_discovery'
  ))
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes (lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_notes_type ON lead_notes (type);
-- THE duplicate-send guard (migration 040), verbatim:
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_notes_unique_followup_send
  ON lead_notes (lead_id, (metadata->>'campaign_id'), (metadata->>'step_number'))
  WHERE type = 'email_sent' AND metadata ? 'step_number';
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_notes_unique_initial_send
  ON lead_notes (lead_id, (metadata->>'campaign_id'))
  WHERE type = 'email_sent' AND NOT (metadata ? 'step_number');

-- ---------- 8. follow_ups (CRM reminders — optional) ----------
CREATE TABLE IF NOT EXISTS follow_ups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  due_date      timestamptz NOT NULL,
  note          text,
  completed     boolean DEFAULT false,
  completed_at  timestamptz,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_lead ON follow_ups (lead_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_pending ON follow_ups (completed, due_date) WHERE completed = false;
```

> Not included (out of email scope, add yours): `domain_intel` (verification catch-all cache — schema not in the email migrations; create a `(domain text PK, is_catch_all bool, has_mx bool, checked_at timestamptz)`-style cache with a 7-day TTL), and `discovered_contacts` (reply-discovery queue). The 040 migration also runs a one-time historical de-dup `DELETE` before building the unique indexes — irrelevant on a fresh DB, so omitted here.

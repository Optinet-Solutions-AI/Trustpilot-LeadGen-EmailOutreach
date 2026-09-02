# Email Outreach Playbook — End to End

> A complete, portable reference for the cold-email outreach system: from choosing a platform and
> pulling leads, to enriching and verifying them, to building a campaign and template, to sending
> within caps, to triaging replies in the inbox. Written so it can be lifted into another project
> with the same goal (scrape leads → verify → personalized cold outreach → manage replies).

The whole thing is one loop:

```
Platform → Leads → Enrich → Verify → Campaign → Template → Test flight → Send (within caps) → Inbox/Replies → Report
```

Two rules sit above everything:

1. **Real data only.** Every lead, email, reply, and number comes from the live system. Never
   invent a lead, guess an email, or report a metric you didn't pull.
2. **Reputation is the whole asset.** Cold email works only while your sending domains stay
   trusted. Going over caps, mailing unverified/invalid addresses, sending from a domain with
   broken SPF/DMARC, or shipping a sloppy template all push you to the spam folder — and recovery
   is slow-to-impossible. When in doubt, choose deliverability over volume.

Everything routes through one API. **Never read/write the database directly, never call a scraper
or sender out of band, never edit the DB to "fix" state** — the dedup, verification, cap, and
audit logic lives in the API. Base URL (local): `http://localhost:3001/api`. Every response is
`{ success: true, data }` or `{ success: false, error }`.

---

## Stage 0 — Pre-flight (run at the start of every session)

Check these before touching anything; report anything red before proceeding.

1. **Server reachable?** `GET /api/campaigns` returns `{success:true}`. If it fails, the API is
   down — start it (`cd server && npm run dev`, port 3001). Do **not** fall back to direct DB access.
2. **Is sending paused?** `EMAIL_SENDING_PAUSED_UNTIL` — an ISO-timestamp kill switch. If set to a
   future time, sending is intentionally halted; don't route around it.
3. **Is test mode on?** `EMAIL_TEST_MODE=true` redirects every send to `TEST_EMAIL_ADDRESS`. A
   "live" send won't reach prospects — surface this so no one is surprised.
4. **Sender health.** `GET /api/email-accounts?role=sender` — for each cold sender note its DNS
   badges (MX/SPF/DMARC/DKIM), today's `dailySent` vs `dailyCap`, and warmup status. An account
   with broken DNS or a red badge is not safe to send volume from.

---

## Stage 1 — Choose a platform

Leads come from pluggable scraping platforms. Each platform is a subclass of a single contract
(`BasePlatformScraper`) and registers itself — adding a platform never edits the orchestrator.

| Platform | Status | How it scrapes | Notes |
|----------|--------|----------------|-------|
| **Trustpilot** | live | Playwright + stealth | Legacy 3-script chain; 2–5s randomized delays to avoid rate limits. |
| **TripAdvisor** | live | ScrapingBee `stealth_proxy` (mandatory) | Direct Playwright is 403'd by Cloudflare. City fan-out via a seeded cities table. |
| **Yelp** | live | Free headed-browser `/search` (listing) + ScrapingBee `/biz` (profile) | Listing is owner-local-only (headed Chrome + residential IP). |
| **Facebook / Instagram / Groups** | planned | logged-in undetected-chromium + residential proxy | Per-account sessions + daily caps; captures post authors & group admins, not just page owners. |

**The flow:** the dashboard renders each platform's `filter_schema` dynamically (Trustpilot needs
country + category + rating; TripAdvisor needs location + listing_type + rating; Yelp needs
country + category + rating + min_review_count). The user fills it in → `POST /api/scrape
{platform, filters, max_results}` creates a `scrape_jobs` row and runs the unified scraper entry
point (`run.py --platform <name> --action list|enrich`).

**Cost discipline:** owner-driven scrapes run **locally** via the Python CLI to save cost; the
remote worker only handles other users' UI-triggered scrapes. Never call a scraper from the
frontend — always go through `POST /api/scrape`.

```bash
# Run a plugin scraper locally (example: Yelp listing)
.venv/Scripts/python.exe tools/scraper/run.py --platform yelp --action list \
  --filters '{"country":"US","category":"plumbers","max_rating":3.5}'
```

---

## Stage 2 — Scrape → enrich → store leads

The scrape job does this in sequence (per the platform plugin):

1. **`scrape_listing(filters)`** — paginates listing pages, applies the rating/review filters,
   returns profile stubs.
2. **`enrich_profiles(stubs)`** — visits each profile, pulls `{company_name, website_url,
   platform_email, phone, screenshot}`, takes a screenshot, uploads it to storage.
3. **`scrape_website.py`** *(optional)* — visits the company site to find a `website_email`.
4. **`upsert_leads.py`** — writes the lead + a `lead_platform_presences(platform, profile_url)` row.

### Lead identity (two-table model)

- `leads` — the lead identity (company_name, website_url, emails, phone, country, category,
  star_rating, screenshot_path, `outreach_status`, `verification_status`). Trustpilot is legacy and
  keys on `leads.trustpilot_url`.
- `lead_platform_presences` — multi-platform identity, unique on `(platform, profile_url)`. Every
  non-Trustpilot platform keys here, with its own `rating`, `platform_email`, and `screenshot_path`.

**Email resolution:** `primary_email` resolves `platform_email > website_email`, skipping any
source whose `*_email_status` is `invalid`. That resolved address is what outreach sends to.

---

## Stage 3 — Verify emails (before they're ever mailed)

Bounces are the fastest way to wreck a domain, so every address is verified before first contact.
The verifier waterfall fires in tiers to conserve paid credits:

1. **ZeroBounce** (primary)
2. **MillionVerifier** (Tier 2 — fires only on a ZeroBounce `unknown`)
3. **Hunter** (Tier 3 — last resort, fires only when ZB **and** MV both return `unknown`)

`verification_status` lands as `valid` / `invalid` / `catch-all` / `unknown`, or stays **NULL** if
no verifier has ever looked at the address. Batch-verify via `POST /api/verify`.

### Verdict policy — what to do with each one

| Verdict | Send? | Why | Enforced where |
|---------|-------|-----|----------------|
| `valid` | **Yes** | Verifier confirmed the mailbox exists. | — |
| `catch-all` | **Cautiously** | The domain accepts *any* address, so a bounce will never tell you the address was wrong — and a spam trap looks identical to a real inbox. Send in small batches from a warmed account, and watch reply/complaint rate rather than bounce rate. Never lead a fresh domain's warm-up with these. | Passes the send gate; UI shows a caution chip |
| `unknown` | **No** | The whole waterfall (ZB → MV → Hunter) failed to decide. Treat it exactly like unverified: no evidence the mailbox exists. | Passes the send gate today — **do not** select them by hand |
| NULL (not verified) | **No** | Nobody has checked. Sending blind is the single fastest way to lose a warmed domain. | **Hard-blocked** at `POST /api/campaigns/:id/send`; override with `allowUnverified: true` only when you have decided to send blind deliberately |
| `invalid` | **Never** | Verifier proved the mailbox does not exist. | **Hard-blocked** everywhere: not selectable in the Lead Matrix or the wizard picker, auto-skipped by `addLeadsToCampaign`, refused at send |

The `unknown` row is the one that needs operator discipline rather than code: the send gate lets it
through because a verifier being inconclusive is not proof of a bad address, but it is not evidence
of a good one either. The practical rule is **treat `unknown` as unverified** — re-verify it, or
leave it out.

### Reading the Lead Matrix honestly

**"Has Email" is not "sendable."** It counts every row carrying any address, verified or not. Sizing
a campaign off that number is what produced the failed Canada / Australia launches on 2026-09-02.

Use the **verification chips** above the table instead — they break the current filter set into
valid / catch-all / unknown / not-verified / invalid and show a **"sendable today"** figure (valid
*and* has an address). Each chip is also a filter shortcut. `GET /api/leads/verification-counts`
serves the same numbers if you need them outside the UI.

The **Prospect type** filter is the other half of the drop-off. A gambling scrape returns the real
operator alongside affiliate review sites, redirects and dead listings; `leads.prospect_type`
(migration 063) separates them, and the Lead Matrix hides the junk by default. Fill the column in
with `tools/db/classify_prospects.py` (dry run by default, `--apply` to write) and promote the
residue to `operator` by hand from the Lead Detail page — the classifier never guesses a lead
*into* `operator`.

**A lead is sendable only when all of these hold:**

- `primary_email IS NOT NULL`
- `verification_status = 'valid'`
- `outreach_status = 'new'` (not yet contacted)
- its email is **not** already in the global sent-emails dedup set

Never relax `verificationStatus=valid` to pad a list. Invalid addresses bounce; bounces kill the
domain.

---

## Stage 4 — Pull the real candidates for a send

```
GET /api/leads?status=new&hasEmail=true&verificationStatus=valid&country=DE&category=...
```

| Param | Use |
|-------|-----|
| `status` | `outreach_status` exact match. `new` = not yet contacted. |
| `hasEmail` | `true` → only leads with a non-null `primary_email`. |
| `verificationStatus` | `valid` for safe first contact. Also accepts `catch-all`, `unknown`, `invalid`, and `unverified` (the synthetic bucket for a NULL verdict). |
| `prospectType` | Comma-joined list from `operator` / `affiliate` / `redirect` / `dead` / `flagged` / `unclassified`. `operator,unclassified` is the working set. |
| `language` | Outreach language name (`Swedish`). Expands to every country that speaks it, so one campaign covers AT + CH + DE for German. Unknown values match nothing rather than everything. |
| `ids` | Comma-joined lead ids — re-read a specific selection through the normal filter path. |
| `country`, `category` | substring (ILIKE) filters. |
| `platform` | inner-joins `lead_platform_presences` (e.g. `trustpilot`, `yelp`). |
| `minRating`, `maxRating` | filter on `star_rating`. |

Helper endpoints:

- `GET /api/leads/ids?hasEmail=true&verificationStatus=valid&country=…` → just `{id, primary_email}`
  for every match (capped 5000). Assemble a send list without paging.
- `GET /api/campaigns/preview-recipients?country=&category=` → `{count, sample[]}`. Fast "how many
  real leads match?" before building anything.
- `GET /api/campaigns/sent-emails` → every address already mailed in any campaign (lowercased).
  **Always dedup new sends against this** so you never double-touch a business.
- `GET /api/leads/verification-counts?<same query as /api/leads>` → `{total, valid, invalid,
  catch-all, unknown, unverified, sendable}` for that filter set. The honest audience size.
- `GET /api/leads/languages` → every outreach language that actually has leads, with its country
  codes and a live count. Powers the language filters.
- `DELETE /api/campaigns/:id/leads` with `{blockedOnly: true}` → drops exactly the pending
  recipients the send gate would refuse. The remediation path when a launch is held back.

---

## Stage 5 — Group by country, choose the send window

A campaign carries **one** timezone (`sending_schedule.timezone`). Send times are local, so:

1. **Group candidates by `country`** and run each country as its own campaign/send with its own
   window. Never mail a German list on Manila time.
2. **Pace, don't blast.** Keep windows a few hours wide; the schedule engine drips sends with
   ~20-min randomized gaps. Narrow windows burst and trip spam filters.

**Choosing the window:** start from current best practice (web-search current B2B cold-email
send-time data for the region if you haven't tuned it), then let your own reply data overrule it
once a country has accumulated real replies (bucket `replied_at` by local hour/weekday and shift
the window toward where replies cluster).

### Starter windows (local time — defaults to tune, not gospel)

| Region | Days | Window (local) |
|--------|------|----------------|
| North America (US, CA) | Tue–Thu | 08:00–11:00, secondary 13:00–15:00 |
| UK / Ireland | Tue–Thu | 08:30–11:00 |
| Western/Central Europe (DE, FR, IT, ES, NL) | Tue–Thu | 08:00–10:30 |
| Australia / NZ | Tue–Thu | 09:00–11:00 |
| Middle East (UAE, etc.) | **Sun–Wed** | 09:00–11:00 (work week is Sun–Thu) |
| Japan | Tue–Thu | 09:00–11:00 |
| Latin America (BR, MX) | Tue–Thu | 09:00–11:00 |

General rules: mid-week (Tue–Thu) beats Monday (inbox backlog) and Friday (checked out);
first-thing-in-the-workday and just-after-lunch are the two reliable peaks; avoid weekends and
local holidays; for non-Mon–Fri work weeks (the Gulf), set `days` to the local work week.

**Country → timezone** is mapped in code (`COUNTRY_TIMEZONE`). Use the zone the map gives you;
don't hardcode timezone strings. Note: this codebase collapses all of Central Europe to a single
representative zone `Europe/Paris` (CET/CEST) — so `Europe/Paris` is the correct choice for a
German campaign here. Common ones: US→`America/New_York`, UK→`Europe/London`, all Central Europe→
`Europe/Paris`, AU→`Australia/Sydney`, JP→`Asia/Tokyo`, PH→`Asia/Manila`, BR→`America/Sao_Paulo`,
AE→`Asia/Dubai`.

---

## Stage 6 — The template (the message itself)

A scheduled send is only as good as the message. The brand sells reputation management & lead-gen
services to small/mid businesses; the recipient is a busy owner who didn't ask to hear from you.
The template has one job: in a few seconds on a phone screen, make them think "this is relevant to
me" and reply.

### What the template engine gives you

`template_subject` and `template_body` (HTML) render through the template engine, which supports:

- **`{{token}}`** — replaced with the lead's real data. Only use fields leads reliably have:
  `{{company_name}}`, `{{website_url}}`, `{{country}}`, `{{category}}`, `{{star_rating}}`.
  **A token with no value renders blank** — that's how `Hi {{first_name}},` becomes `Hi ,` in
  front of a prospect. The test flight is where you catch an empty one.
- **`{spintax|variants}`** — picks one variant at random per send, so messages aren't byte-identical
  (near-identical bulk mail is a spam fingerprint). Vary real wording — greeting, value sentence,
  CTA phrasing — not just punctuation.
- **`include_screenshot`** — embeds the lead's captured screenshot (their review profile/page).
  Strong personalization ("here's your actual Trustpilot page") when the screenshot is real and
  on-point.

### The quality bar (a template that fails the first three shouldn't send)

1. **Relevant on arrival** — subject + first line connect to *this* recipient (their business,
   category, rating, review situation). Generic "Grow your business" gets deleted.
2. **One clear, valuable point** — say the single thing that matters to them in plain language. No
   feature dump, no "we are a leading provider of…".
3. **One soft CTA** — ask for a small yes (a quick reply, a 10-minute call, "worth a look?"), not a
   hard sell or a calendar wall.
4. **Short** — a few short sentences; fits on a phone without scrolling.
5. **Human, not markety** — one person emailing another. No hype words, no exclamation spam, no
   "Dear Sir/Madam". Real signature with the sender's name and brand.
6. **Spam-trigger light** — avoid ALL-CAPS, "FREE", "100% guaranteed", "act now", multiple `!!!`,
   walls of links, hidden text, giant image-only emails. One link max in a first touch.
7. **Honest & compliant** — accurate subject (no bait-and-switch), real sender identity, clear way
   to opt out.

**Personalize only from real lead data.** Reference `{{company_name}}`, `{{category}}`,
`{{star_rating}}`, or the embedded screenshot — those are true and system-sourced. **Never invent**
a detail to sound personal ("I saw your recent 5-star review from Maria…"); a fabrication blows up
the moment a prospect reads it. No personal hook for a batch? Lean on category/location relevance.

### Follow-ups

Follow-up steps (`campaign_steps`, step 2+) lift reply rates, but each must add something — a new
angle, a shorter nudge, a different proof point — not "bumping this up." Keep them short and easy to
say no to, and **stop the sequence the moment a real reply or an unsubscribe comes in.**

---

## Stage 7 — Build the campaign

The dashboard builds campaigns through a 5-step wizard: **setup → template → follow-ups →
recipients → review**. The equivalent API calls:

| Call | Purpose |
|------|---------|
| `POST /api/campaigns` | Create (name, template_subject, template_body, include_screenshot, sending_schedule). |
| `POST /api/campaigns/:id/leads {leadIds}` | Attach the deduped lead IDs (creates `campaign_leads` rows, status `pending`). |
| `POST /api/campaigns/:id/duplicate` | Clone an existing campaign. |
| `GET /api/campaigns/:id/steps` | Follow-up steps. |

### `sending_schedule` (jsonb on the campaign)

```jsonc
{
  "timezone": "Asia/Manila",      // IANA; ONE timezone per campaign
  "startHour": "09:00",           // local
  "endHour":   "17:00",           // local; if <= startHour the window crosses midnight
  "days": [1,2,3,4,5],            // 0=Sun … 6=Sat
  "dailyLimit": 50,
  "senderAccountIds": ["<uuid>"]  // pinned senders ("__env__" = env account); rotates if multiple
}
```

Because there's one timezone per campaign, split leads by country into separate campaigns/sends so
each gets its own local window. Size each country's batch to its senders' **live** remaining daily
cap — timing never overrides caps.

---

## Stage 8 — Sender accounts & caps

There is **no single sender env var** — every send resolves to a row in `email_accounts`. Supported
`auth_type`: `gmail_oauth` (Gmail API + refresh token), `smtp` (Nodemailer SMTP + IMAP, e.g.
Bluehost/Titan, DreamHost), `app_password` (Gmail SMTP via app password).

`GET /api/email-accounts?role=sender` returns per account: `email`, `from_name`, `auth_type`,
`status`, live `dailySent`/`hourlySent`, **computed** `dailyCap`/`hourlyCap`, warmup state
(`warmupDay`/`warmupStatus`/`warmupTargetCap`/`warmupRampDays`), `isColdSender`, and `dns:{mx, spf,
dmarc, dkim, checkedAt}`.

### Caps are living data, not a constant

- Starting cap is **50/day per account**, computed from the warmup curve: ramps from ~10/day toward
  `warmup_target_cap` (default 50) over `warmup_ramp_days` (default 21). So caps differ per account
  and rise over time. **Always read the live value — never hardcode 50.**
- Schedule and send **per account**, never globally. If an account has sent 40 of 50, only 10 more
  go out from it today; the rest wait or move to an account with headroom.
- **Raising a cap is an operator decision.** When an account consistently hits its cap with healthy
  deliverability (low bounces, replies coming in, green DNS) and has ramped long enough, recommend a
  bump and explain the warmup reasoning — but don't change it yourself.
- `PATCH /api/email-accounts/:id {dailyCap?, hourlyCap?, warmupTargetCap?, warmupRampDays?, status?}`
  — operator-approved only. `POST /api/email-accounts/:id/dns-refresh` re-checks DNS (SMTP only).

**Deliverability prerequisites:** MX + SPF + DMARC configured on the sending domain (fix red DNS
badges before sending volume). Warm up: start at 10–20/day per account, ramp over 2–4 weeks. Use
personal-provider addresses (Gmail/Yahoo/Outlook) only as custom-domain aliases — sending bulk cold
mail directly from free Gmail inboxes is a spam trap.

---

## Stage 9 — Test flight (mandatory, no exceptions)

```
POST /api/campaigns/:id/test-flight {testEmail}
```

It renders the real template with a real lead's data and sends **one** copy (DNS-gates SMTP
senders). Read it as a prospect would: every token filled, links work, screenshot (if on) is right,
spintax reads naturally, the whole thing looks good on a phone. **A live send without a passing test
flight is the one thing you never do** — it's how a broken token or empty field goes out to hundreds
of prospects. If anything looks off, fix it and re-test.

A new or substantially rewritten template going live is an operator-approved step: present the
rendered preview and let the operator bless it before the first real send.

---

## Stage 10 — Go live (the gated step)

With a passing test flight, the **first live send of a campaign** is an operator decision. Present
the plan — who, how many, which senders, what window, caps respected — get the green light, then:

```
POST /api/campaigns/:id/send {testMode?, testEmail?, limit?}
```

This hard-blocks any `verification_status='invalid'` lead, dedups against sent-emails, DNS-gates
SMTP senders, then async-sends. `POST /api/campaigns/:id/cancel` pauses (sets status back to
`draft`; scheduler stops sending it).

> Approval to send one campaign is **not** standing approval for the next. Each campaign's first
> live send is its own decision.

### How sends actually go out (the scheduler)

A background loop polls **every 60s**, takes up to 10 due emails per tick, and only sends
`campaign_leads` that are `pending`, `channel='email'`, `scheduled_at <= now`, whose campaign is
`status='sending'`. It picks senders by rotation, **skips any account at its daily/hourly cap**
(counted from `campaign_leads.sender_email` over the last 24h/1h), spreads sends across the window
with DST-correct ~20-min gaps, and records `sender_email` on each send. You don't drive the
per-email send — you set up the campaign correctly and the scheduler paces it within caps and window.

---

## Stage 11 — Monitor

Track against the **live** state, never from memory:

- `GET /api/campaigns/:id/stats` → `total_sent/opened/replied/bounced/auto_replied` + rates.
- `GET /api/campaigns/:id/leads` → per-lead `status`, `email_used`, `sender_email`, `scheduled_at`,
  `sent_at`, `replied_at`, `reply_snippet`.
- `GET /api/email-accounts` → live per-account caps + DNS (authoritative).
- `GET /api/analytics?period=7d|30d|all` → the dashboard aggregate (totalLeads, leadsByStatus,
  leadsByCountry, per-campaign rollups).

**A rising bounce rate is a deliverability emergency, not a footnote.** If bounces spike or an
account errors, pause and report.

---

## Stage 12 — The inbox: triage replies

A reply count only matters if it counts the right things. Pull new replies:

```
POST /api/gmail/check-replies      # Gmail + all IMAP/SMTP accounts → {gmail, imap, totalReplies}
POST /api/gmail/check-bounces      # scan for mailer-daemon delivery failures
```

### Layer 1 — the rule layer (automatic)

Every reply runs through `classifyReply()`, scoring RFC auto headers (`Auto-Submitted`,
`X-Autoreply`, `Precedence: bulk`…), helpdesk ticket headers (Zendesk/Freshdesk/Intercom…), subject
patterns ("Out of Office", "Ticket #123"), and body phrases ("this inbox is unmonitored"). It emits
one of three verdicts:

| Verdict | System action | Means for you |
|---------|---------------|----------------|
| `human` (score < 0.4) | `campaign_leads.status='replied'`, lead `outreach_status='replied'`, `total_replied++` | A person replied. **Read it for intent.** |
| `auto` | `status='auto_replied'`, lead stays `contacted`, `total_auto_replied++` | OOO / autoresponder. Not a prospect. |
| `ticket` | `status='auto_replied'` (+ helpdesk note) | Helpdesk auto-ack. Not a prospect. |

**Only `status='replied'` counts as a real reply.** When you report reply numbers, count `replied`,
not `replied + auto_replied`.

### Layer 2 — read the human ones for intent

For each `human` reply, open the actual thread (`GET /api/inbox/thread/:threadId?lead=<email>` for
Gmail, `GET /api/inbox/thread-smtp/:canonicalId` for SMTP) — never judge from the snippet or from
memory. Classify intent:

- **Hot** — wants to talk (price/availability, a call/demo, "tell me more"). Surface immediately.
- **Warm** — open but not committed ("send details", "maybe Q3"). Worth a thoughtful follow-up.
- **Not a fit / no** — explicit decline. Mark the lead `lost`; never re-contact. A clean no protects
  the domain.
- **Unsubscribe / hostile** — "remove me", "stop", complaint. **Highest priority to honor.** Stop
  all contact with that address/domain immediately and flag it; ignoring this gets domains blacklisted.
- **Automated (missed by rules)** — reads as a bot despite the `human` verdict. Treat as noise; note
  the classifier missed it.

Also sanity-check a sample of the `auto`/`ticket` pile for **false negatives** (a real human
mis-marked as auto). If the classifier is systematically wrong, flag it as a code issue.

### Layer 3 — promote and act

- Hot/warm prospects → `POST /api/inbox/promote-to-prospects {campaignLeadIds}` and surface them in
  the report with a one-line intent read each.
- Reply in-thread → `POST /api/inbox/reply/:campaignLeadId {body, subject?}`. A substantive reply to
  a real prospect is operator-facing — draft it, but treat sending as the operator's call unless they
  said to handle replies directly.
- Declines → mark `lost`. Unsubscribes → stop contact and flag.

### Inbox list view

`GET /api/inbox/campaign-replies?folder=replies&campaignType=` → list of replies with
`company_name`, `status`, `reply_snippet`, `sender_email`, `replied_at`, thread ids.

### Ground-truth audit ("who *actually* replied?")

When the numbers look off, re-pull the real inbound bodies from IMAP and re-run the classifier
rather than trusting stored status:

```bash
cd server && npx tsx scripts/find-human-replies.ts                # re-check replied rows
cd server && npx tsx scripts/find-human-replies.ts --include-auto # also re-scan auto_replied (false negatives)
cd server && npx tsx scripts/find-human-replies.ts --csv > replies.csv
```

It prints a HUMAN / AUTO-TICKET / NOT-FOUND breakdown with confidence scores — the authoritative
answer to "is this reply real?"

### Discovered contacts (a bonus from auto-replies)

OOO and partnership autoresponders often *name another contact* ("for sales, email jane@…"). The
system extracts those into a `discovered_contacts` review queue — a real, system-sourced place to
grow the list rather than inventing contacts.

---

## Stage 13 — Report

Close every working session with a short, honest, scannable ops update:

- What you did (leads pulled, campaigns scheduled/sent, replies triaged) — outcomes, not steps.
- Live numbers, pulled fresh: sent today per account vs cap, total in-flight, reply count (real vs
  automated), bounce rate, any red DNS.
- Real prospect replies surfaced for the operator, with a one-line intent read each.
- Anything waiting on the operator (a send to approve, a cap to raise, a template to bless).
- **Never report a number you didn't just pull. Never claim a send succeeded without confirming it
  in the live data.**

---

## When to stop and ask (vs. act autonomously)

Operate autonomously through the safe, reversible parts — pulling leads, grouping, checking caps/DNS,
drafting/scheduling, running the test flight, triaging replies, reporting. **Stop and get a green
light** at the irreversible, outward-facing, or judgment moments:

- The **first live send** of any campaign (test flight passing).
- **Raising any daily/hourly cap** or changing warmup settings.
- Putting a **new or substantially rewritten template** in front of prospects.
- **Resuming sending** when the pause switch is set, or any test-mode state that contradicts
  expectations.
- Mailing any address you're **not confident is real and verified**, or any action you can't cleanly
  undo and aren't sure about.

When you stop, lead with a recommendation in a line or two — not a wall of options.

---

## API quick reference

### Scrape & leads
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/scrape` | POST | Start a scrape job `{platform, filters, max_results}` |
| `/api/scrape` | GET | List jobs |
| `/api/scrape/:id/status` | GET SSE | Live progress |
| `/api/leads` | GET | Paginated + filterable leads |
| `/api/leads/ids` | GET | `{id, primary_email}` for every match (cap 5000) |
| `/api/leads/:id` | GET/PATCH/DELETE | Single lead |
| `/api/leads/bulk` | PATCH | Bulk update |
| `/api/verify` | POST | Batch email verification (ZeroBounce→MillionVerifier→Hunter) |

### Campaigns & sending
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/campaigns` | GET/POST | List + create |
| `/api/campaigns/:id` | PATCH/DELETE | Update / delete |
| `/api/campaigns/:id/leads` | GET/POST | List or attach leads |
| `/api/campaigns/:id/test-flight` | POST | **Mandatory** pre-send `{testEmail}` |
| `/api/campaigns/:id/send` | POST | Launch `{testMode?, testEmail?, limit?}` |
| `/api/campaigns/:id/cancel` | POST | Pause (status → draft) |
| `/api/campaigns/:id/duplicate` | POST | Clone |
| `/api/campaigns/:id/stats` | GET | sent/opened/replied/bounced/auto_replied |
| `/api/campaigns/:id/steps` | GET | Follow-up steps |
| `/api/campaigns/preview-recipients` | GET | Count leads matching filters |
| `/api/campaigns/sent-emails` | GET | Global dedup set of mailed addresses |
| `/api/campaigns/rate-limit` | GET | Per-account rate-limit snapshot |
| `/api/campaigns/warmup-status` | GET | Warmup ramp state |

### Senders & inbox
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/email-accounts` | GET/POST | List + create sender accounts |
| `/api/email-accounts/:id` | PATCH | Caps/warmup/status (operator-approved) |
| `/api/email-accounts/:id/dns-refresh` | POST | Re-check DNS (SMTP) |
| `/api/gmail/check-replies` | POST | Pull replies (Gmail + IMAP), auto-classify |
| `/api/gmail/check-bounces` | POST | Scan for delivery failures |
| `/api/inbox/campaign-replies` | GET | List replies |
| `/api/inbox/thread/:threadId` | GET | Full Gmail thread |
| `/api/inbox/thread-smtp/:canonicalId` | GET | Full SMTP/IMAP thread |
| `/api/inbox/promote-to-prospects` | POST | Promote hot/warm replies |
| `/api/inbox/reply/:campaignLeadId` | POST | Reply in-thread |
| `/api/analytics` | GET | Dashboard aggregates |

All routes return `{ success: true, data }` or `{ success: false, error }`.

### Env switches that change sending behavior
| Var | Effect |
|-----|--------|
| `EMAIL_SENDING_PAUSED_UNTIL` | ISO kill switch — scheduler halts all sends until it passes. |
| `EMAIL_TEST_MODE` | `true` → every send redirected to `TEST_EMAIL_ADDRESS`. |
| `TEST_EMAIL_ADDRESS` | Where test-mode + test-flight mail goes. |
| `MANUAL_LEADS_ONLY` | `true` → only manually-added emails may be sent; scraped leads skipped. |
| `EMAIL_PLATFORM` | `none` in production (direct Gmail/SMTP). Instantly adapter exists but is unused. |
| `EMAIL_MIN_DELAY` / `EMAIL_MAX_DELAY` | Global min/max ms between sends (per-account cap takes precedence). |

---

## Things you never do

- Write to the database directly, or run a sender/scraper outside the API.
- Relax `verificationStatus=valid`, or send to `invalid` leads, to grow the list.
- Exceed an account's live `dailyCap`, or change caps without operator approval.
- Send without a passing test flight.
- Call a scraper or sender from the frontend.
- Report a count you didn't just pull from the live system.
- Invent a lead, guess an email, or paraphrase a reply you didn't read.

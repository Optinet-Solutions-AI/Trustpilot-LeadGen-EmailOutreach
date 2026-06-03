# Workflow: Colleague-Network Email Warm-Up

## Objective

Systematically improve inbox placement and domain sender reputation for the 9 `is_cold_sender = true` accounts by sending neutral, transactional-style emails to a controlled internal colleague network and having those colleagues perform high-value engagement (Reply + Forward). Trains Gmail/Outlook filters to treat these mailboxes as trusted before the next live cold-outreach push.

Intended duration: **~3 weeks**, then disable.

## What runs automatically

The `startColleagueWarmupScheduler()` in [server/src/services/colleague-warmup/scheduler.ts](../server/src/services/colleague-warmup/scheduler.ts) wakes every 60 seconds and:

1. **Guards** — skips the tick if `COLLEAGUE_WARMUP_ENABLED !== 'true'` or if it's outside the Mon–Fri 3:00pm–10:00pm Asia/Manila window. **Does NOT honor `EMAIL_SENDING_PAUSED_UNTIL`** — that flag pauses cold outreach campaigns, but the whole point of this warm-up is to rehabilitate sender reputation during exactly those incidents.
2. **Plans the day** — once per Manila day, computes the **workday index** from `COLLEAGUE_WARMUP_START_DATE` (today included if today is Mon-Fri and on/after that date). Daily target per sender = `5 + (workdayIndex - 1)`, capped at 20. **Each sender independently shuffles the 26-recipient pool and picks the next N in rotation** (no repeats within a sender's day until the rotation wraps). Sends are spaced 45–50 min apart per sender, randomly jittered, with a small per-sender initial offset so the 9 senders don't fire in lockstep.
3. **Emails Cathy** — when a plan exists for the day (workdayIndex >= 1 with senders available), sends ONE HTML preview from `jhonquillycampilanan@gmail.com` to `cathylyn@optinetsolutions.com` listing every planned send.
4. **Dispatches due rows** — any plan rows whose `send_at_utc` has arrived are sent via [server/src/services/email-sender.ts](../server/src/services/email-sender.ts).

The 9 senders are loaded from `email_accounts` where `is_cold_sender = true AND status = 'active'`. The 25 recipients and ~30 subject lines are inlined in [server/src/services/colleague-warmup/config.ts](../server/src/services/colleague-warmup/config.ts).

### Volume ramp (per sender, per workday)

| Workday | Sends/sender | Total across 9 senders |
|---:|---:|---:|
| 1 | 5 | 45 |
| 2 | 6 | 54 |
| 5 | 9 | 81 |
| 10 | 14 | 126 |
| 16+ | 20 (cap) | 180 |

Workdays count Mon-Fri only — Sat/Sun are skipped.

## What humans do (this is the whole point)

The strategy depends on **manual engagement** by the colleague recipients. The scheduler does NOT auto-reply.

For every warmup email that lands in their inbox, each colleague must:

1. **Reply** — open the email and send a short positive reply ("Got it, thanks!", "All good here", whatever feels natural). Real outbound traffic from the recipient's account is the strongest possible signal.
2. **Forward** — forward the same email to another internal colleague with a brief one-liner.

**Hard rule — Spam-folder override:** If a warmup email lands in the Spam folder, the colleague must **NOT** click "Not Spam". Leave it in Spam. The warm-up process is what teaches the filter; clicking "Not Spam" is a one-time fix that masks the signal we're trying to train against.

Cathy reviews the daily preview at 3:00pm Manila and coordinates with colleagues as needed.

## How to enable and disable

### Pre-launch checklist

- [ ] `jhonquillycampilanan@gmail.com` exists in `email_accounts` with valid SMTP credentials (used only for Cathy notifications)
- [ ] All 9 `is_cold_sender=true` accounts have `status='active'` in `email_accounts`
- [ ] `cathylyn@optinetsolutions.com` mailbox is reachable
- [ ] All 26 colleagues have been briefed on the human protocol (Reply + Forward, NO "Not Spam")
- [ ] `COLLEAGUE_WARMUP_START_DATE` is set (Manila YYYY-MM-DD). The first Mon-Fri on/after this date becomes Workday 1 (5 sends/sender).

### Enable

Set both env vars together so the start date and the on switch land in the same revision:

```powershell
powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --project=trustpilot-leadgen --update-env-vars 'COLLEAGUE_WARMUP_ENABLED=true,COLLEAGUE_WARMUP_START_DATE=2026-06-01' --quiet"
```

If today is on/after the start date AND it's Mon-Fri 3pm–10pm Manila: Cathy receives the daily preview within ~60s, first real warmup send fires within ~47 min.
If today is before the start date OR a weekend: scheduler ticks but logs `no plan today` and sends nothing.

### Disable (after ~3 weeks)

```powershell
powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --project=trustpilot-leadgen --update-env-vars 'COLLEAGUE_WARMUP_ENABLED=false' --quiet"
```

### Emergency stop (immediate)

Flip the dedicated colleague-warmup kill switch. `EMAIL_SENDING_PAUSED_UNTIL` does NOT pause colleague warm-up (by design — see Guards section above).

```powershell
powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --project=trustpilot-leadgen --update-env-vars 'COLLEAGUE_WARMUP_ENABLED=false' --quiet"
```

## How to read Cathy's daily preview

Cathy receives an email at 3:00pm Manila titled `Warmup plan for YYYY-MM-DD (Day) — N sends`. Body is an HTML table:

| # | Time (Manila) | Sender | Recipient | Subject |
|---|---|---|---|---|
| 1 | 15:03 | sender1@... | leo@... | Welcome to your new account |
| 2 | 15:04 | sender3@... | raphael@... | Account Activation Update |
| … | … | … | … | … |

That table IS the audit trail — there's no separate DB log. If a row never appears in the corresponding sender's "Sent" folder, check Cloud Run logs for `[ColleagueWarmup]` lines that day.

## Daily volume

- Window: 7 hours (3pm–10pm Asia/Manila)
- Cadence: 45–50 min between sends per sender (jittered)
- Daily target per sender: ramped via `COLLEAGUE_WARMUP_START_DATE` — 5 on Workday 1, +1 per workday, capped at 20
- Total across 9 senders: 45 emails on Workday 1 → 180 emails/workday at cap
- Per colleague (26 in pool): ~1.8 received/workday on Workday 1 → ~7.2/workday at cap

### Recipient rotation

Each sender independently shuffles the 25 recipients at the start of each workday and picks the next N in rotation. So:
- A single sender's daily sends are to DISTINCT recipients (until the rotation wraps when `dailyTarget > 25`).
- Different senders may hit the same recipient on the same day (independent shuffles).

## Editing the colleague list or subject bank

Both are inlined in [server/src/services/colleague-warmup/config.ts](../server/src/services/colleague-warmup/config.ts). Edit, commit, and redeploy via the standard `gcloud run deploy trustpilot-crm` command — the change takes effect on the next Manila day's plan.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| No Cathy email at 3pm | Check Cloud Run logs for `[ColleagueWarmup/Notifier]` — likely `jhonquillycampilanan@gmail.com` is missing from `email_accounts` or its OAuth refresh token is invalid. Reconnect via the Email Accounts page. |
| `No active is_cold_sender accounts` log | No rows match `is_cold_sender = true AND status = 'active'`. Mark the 9 cold-sender accounts via the Email Accounts admin UI or directly in `email_accounts`. |
| Need to stop sends immediately during a deliverability scare | Use `COLLEAGUE_WARMUP_ENABLED=false`. The cold-outreach kill switch (`EMAIL_SENDING_PAUSED_UNTIL`) does NOT affect this scheduler. |
| Cold-start mid-day; Cathy didn't get a re-notification | By design. Cathy already received the morning preview from the previous instance. Look at logs for `Cold-start at HH:MM Manila — resuming silently`. |
| Some sends marked `failed` in logs | Per-account auth issue. Inspect the specific sender via `GET /api/warmup/status` and/or the Email Accounts page; reconnect the account. The scheduler does not retry within the same day. |

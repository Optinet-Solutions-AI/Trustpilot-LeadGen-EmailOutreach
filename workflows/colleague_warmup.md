# Workflow: Colleague-Network Email Warm-Up

## Objective

Systematically improve inbox placement and domain sender reputation for the 9 `is_cold_sender = true` accounts by sending neutral, transactional-style emails to a controlled internal colleague network and having those colleagues perform high-value engagement (Reply + Forward). Trains Gmail/Outlook filters to treat these mailboxes as trusted before the next live cold-outreach push.

Intended duration: **~3 weeks**, then disable.

## What runs automatically

The `startColleagueWarmupScheduler()` in [server/src/services/colleague-warmup/scheduler.ts](../server/src/services/colleague-warmup/scheduler.ts) wakes every 60 seconds and:

1. **Guards** — skips the tick if `COLLEAGUE_WARMUP_ENABLED !== 'true'`, if `EMAIL_SENDING_PAUSED_UNTIL` is in the future, or if it's outside the Mon–Fri 3:00pm–10:00pm Asia/Manila window.
2. **Plans the day** — once per Manila day (at the 3:00pm tick or on cold-start), generates ~80 randomized `(sender, recipient, subject, send_at_utc)` rows. Per-sender cadence is 45–50 min uniformly jittered.
3. **Emails Cathy** — at the 3:00pm tick, sends ONE HTML preview from `jhonquillycampilanan@gmail.com` to `cathylyn@optinetsolutions.com` listing every planned send for the day. Cold-starts mid-workday do NOT re-notify.
4. **Dispatches due rows** — any plan rows whose `send_at_utc` has arrived are sent via [server/src/services/email-sender.ts](../server/src/services/email-sender.ts).

The 9 senders are loaded from `email_accounts` where `is_cold_sender = true AND status = 'active'`. The 25 recipients and ~30 subject lines are inlined in [server/src/services/colleague-warmup/config.ts](../server/src/services/colleague-warmup/config.ts).

## What humans do (this is the whole point)

The strategy depends on **manual engagement** by the colleague recipients. The scheduler does NOT auto-reply.

For every warmup email that lands in their inbox, each colleague must:

1. **Reply** — open the email and send a short positive reply ("Got it, thanks!", "All good here", whatever feels natural). Real outbound traffic from the recipient's account is the strongest possible signal.
2. **Forward** — forward the same email to another internal colleague with a brief one-liner.

**Hard rule — Spam-folder override:** If a warmup email lands in the Spam folder, the colleague must **NOT** click "Not Spam". Leave it in Spam. The warm-up process is what teaches the filter; clicking "Not Spam" is a one-time fix that masks the signal we're trying to train against.

Cathy reviews the daily preview at 3:00pm Manila and coordinates with colleagues as needed.

## How to enable and disable

### Pre-launch checklist

- [ ] `jhonquillycampilanan@gmail.com` exists in `email_accounts` with valid Gmail OAuth credentials (used only for Cathy notifications)
- [ ] At least one — ideally nine — `email_accounts` rows have `is_cold_sender = true` AND `status = 'active'`
- [ ] `cathylyn@optinetsolutions.com` mailbox is reachable
- [ ] All 25 colleagues have been briefed on the human protocol (Reply + Forward, NO "Not Spam")
- [ ] `EMAIL_SENDING_PAUSED_UNTIL` is unset or in the past

### Enable

```powershell
powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --project=trustpilot-leadgen --update-env-vars 'COLLEAGUE_WARMUP_ENABLED=true' --quiet"
```

Watch the first Cathy preview land at the next 3:00pm Manila tick. First real warmup send follows within ~47 min.

### Disable (after ~3 weeks)

```powershell
powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --project=trustpilot-leadgen --update-env-vars 'COLLEAGUE_WARMUP_ENABLED=false' --quiet"
```

### Emergency stop (immediate)

Same as the cold-outreach kill switch:

```powershell
powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --project=trustpilot-leadgen --update-env-vars 'EMAIL_SENDING_PAUSED_UNTIL=2026-12-31T23:59:59Z' --quiet"
```

The colleague-warmup scheduler honors this kill switch in addition to the existing cold-outreach scheduler.

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
- Cadence: 45–50 min per sender → ~8–9 sends per sender per workday
- Total: ~72–81 emails per workday across the 9 senders
- Per colleague: ~3 received per workday on average

## Editing the colleague list or subject bank

Both are inlined in [server/src/services/colleague-warmup/config.ts](../server/src/services/colleague-warmup/config.ts). Edit, commit, and redeploy via the standard `gcloud run deploy trustpilot-crm` command — the change takes effect on the next Manila day's plan.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| No Cathy email at 3pm | Check Cloud Run logs for `[ColleagueWarmup/Notifier]` — likely `jhonquillycampilanan@gmail.com` is missing from `email_accounts` or its OAuth refresh token is invalid. Reconnect via the Email Accounts page. |
| `No active is_cold_sender accounts` log | No rows match `is_cold_sender = true AND status = 'active'`. Mark the 9 cold-sender accounts via the Email Accounts admin UI or directly in `email_accounts`. |
| Scheduler tick logs `EMAIL_SENDING_PAUSED_UNTIL active — skipping tick` | The cold-outreach incident kill switch is on. Unset it once the incident is resolved. |
| Cold-start mid-day; Cathy didn't get a re-notification | By design. Cathy already received the morning preview from the previous instance. Look at logs for `Cold-start at HH:MM Manila — resuming silently`. |
| Some sends marked `failed` in logs | Per-account auth issue. Inspect the specific sender via `GET /api/warmup/status` and/or the Email Accounts page; reconnect the account. The scheduler does not retry within the same day. |

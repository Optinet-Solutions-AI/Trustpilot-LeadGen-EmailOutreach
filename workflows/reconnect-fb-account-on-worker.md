# Runbook — Re-connect a Facebook account (james) on the EC2 worker

**When to run:** FB scrapes on the worker fail at the login gate, or `social_accounts.connect_status` is stale / `status≠active`, or you see "account session stale — run Connect first." A worker FB session typically lapses every ~2-4 weeks (FB invalidates it).

**Why it matters:** the worker (`windows-fb-worker-1`, instance `i-0a373a528fdf851ff`, region `ap-southeast-1`) keeps its OWN session per account at `C:\fb-profiles\<account_id>`. Re-logging in *locally* on the owner's laptop does NOT refresh the worker's session. This is the **one** step that unblocks (a) real FB scraping for all users and (b) the remote "Open James's browser" feature.

**Account:** james@optiratesolutions.net — `social_accounts.id = 0eec969c-a888-4e54-bdfe-057ca11c2af5`, pinned `country=PH`.

---

## Primary path — in-app Connect (no SSH/RDP)

This uses the existing connect flow (`server/src/worker/social-connect-worker.ts` + `scripts/ec2-windows-spawn-noVNC.ps1`). The DB is the message bus; you never touch the EC2 directly.

1. **Open the app → Social Accounts page.** Find james.
2. **Click "Connect Facebook"** on james's card. (Calls `POST /api/social-accounts/<id>/connect` → sets `connect_status='requested'`.)
3. **Wait ~10-20s.** The worker's poll loop claims it (`connect_status` → `provisioning`), spawns Brave + a VNC/noVNC server + a `cloudflared` tunnel, and writes `connect_tunnel_url` + `connect_status='ready'`. The app surfaces the tunnel link (modal/new tab).
4. **Open the tunnel** → you're driving james's Brave running ON the EC2. **Log into Facebook as james** — email/password, and clear any 2FA / captcha / "this was me" device-trust prompt. Get to the normal FB homepage.
5. The worker watches the profile's `Default\Network\Cookies` for the `c_user` cookie; on first sight it pulls the cookies via CDP, encrypts them, sets `social_accounts.status='active'` + `connect_status='captured'`, `last_login_at=now`, and kills Brave/tunnel/noVNC. The modal closes.
6. **Done** — james's session is fresh on the worker.

**TTL:** you have **10 minutes** to finish login (`connect_expires_at`); if you don't, `connect_status='expired'` and you just click Connect again.

---

## Verify it worked

```bash
# james should be active + captured + a fresh last_login_at (today):
curl -s https://trustpilot-gateway-3lazv1k9.uc.gateway.dev/api/social-accounts \
  | python -c "import sys,json;[print(r['handle'],r['status'],r.get('connect_status'),r.get('last_login_at')) for r in json.load(sys.stdin)['data'] if r['platform']=='facebook']"
```
Then a **PH** test scrape (james's country) — it should run on the worker without the login-gate crash:
- Submit a Facebook consumer scrape with `location=Manila` (→ PH → james) from the app. It should reach posts, not "Scrape blocked / login gate."

---

## If it stalls (fallback — SSM into the worker)

Access the Windows worker via **AWS SSM Session Manager** (no SSH key): instance `i-0a373a528fdf851ff`, region `ap-southeast-1`.

| Symptom | Cause | Fix |
|---|---|---|
| Stuck at `requested` >30s, never `provisioning` | the connect-worker daemon isn't polling | SSM in → confirm the Node process / NSSM service is up **with `ENABLE_SOCIAL_CONNECT_WORKER=1`** (the loop is gated on it) → restart it. |
| `connect_status='failed'` | spawn script error | read `social_accounts.connect_error` (the worker writes the PowerShell tail there) — usually missing `cloudflared`/VNC/Brave on the box. |
| `connect_status='expired'` | login not finished in 10 min | just click Connect again and move faster through 2FA/captcha. |
| Tunnel opens to a login page repeatedly | FB rejecting the EC2 IP/fingerprint | this is the known EC2-FB-trust issue — see `memory/project_fb_login_state_2026-06-01.md`; may need the residential proxy + a patient device-trust pass. |

---

## Notes
- This is an **occasional admin task**, not per-user. Once james is re-connected centrally, **every** app user's FB action runs as james automatically (server/worker side) — no per-user login.
- The remote "Open James's browser" feature (PR #2) builds on this exact flow; once its `mode='browse'` worker branch (Task 4) ships, the same noVNC tunnel is reused to *drive* james for ad-hoc work, not just login.
- Same procedure applies to any future fleet account (swap the account id / handle).

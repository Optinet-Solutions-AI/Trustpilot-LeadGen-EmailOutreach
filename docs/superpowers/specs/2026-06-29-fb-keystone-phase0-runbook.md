# Phase 0 Runbook — FB residential-session keystone spike (THROWAWAY)

> Goal: prove ONE Facebook session can be **logged in and held for 48h on a server**, headful, through a **residential IP via plain `--proxy-server` (IP-whitelisted, no selenium-wire)**, with **no checkpoint**. This single result decides whether the whole hosted multi-user plan runs on Linux EC2 or falls back to the proven Windows EC2 box. No repo code is written in this phase.

This is operator-executed (SSM + a burner account + proxy). The steps below are the exact runbook.

---

## Prerequisites (operator must obtain)
1. **A burner FB account** — NOT james@. We expect this account to risk a checkpoint; that is the point. Have its login + password.
2. **An IP-whitelisted residential proxy endpoint.** The current Enigma config in `.env` authenticates by username/password (country encoded in the password) — that path forces selenium-wire, which is the documented-broken mechanism we are trying to avoid. For Phase 0 we need ONE of:
   - Enigma (or any provider) configured to **whitelist the EC2 egress IP** so a plain `http://host:port` needs no auth, OR
   - a sticky residential session endpoint that accepts the EC2 IP.
   Pin the proxy to the **same country as the burner account** (e.g. PH for a PH account).
3. **SSM access** to the Linux EC2 worker (`i-0188e136ef92d0c07`, Singapore) — no SSH key needed (AWS SSM Session Manager).

> If an IP-whitelisted endpoint cannot be arranged, do NOT silently fall back to the auth-extension/selenium-wire path — that is what we are testing *away from*. Note it and we adjust the plan (auth-extension becomes a documented secondary mode in Phase 1a, but it must be proven separately).

---

## Step 1 — Confirm the proxy routes and geolocates correctly (cheap, do FIRST)
On the EC2 box, before any browser:
```bash
curl -s --proxy http://<PROXY_HOST>:<PROXY_PORT> https://api.ipify.org
# → should print a residential IP, NOT the EC2 datacenter IP
```
Then geo-check that IP (any IP-geo service) and confirm it resolves to the **burner account's pinned country**. If it returns the EC2 IP or the wrong country, STOP — fix the proxy before continuing.

## Step 2 — Install headful Chrome + Xvfb on Linux EC2
```bash
sudo dnf install -y google-chrome-stable xorg-x11-server-Xvfb x11vnc fluxbox || \
  sudo apt-get install -y google-chrome-stable xvfb x11vnc fluxbox
```
(`ec2-fb-login-session.sh` already installs Xvfb/x11vnc/fluxbox idempotently — reuse it as reference.)

## Step 3 — Launch headful Chrome under Xvfb, plain `--proxy-server`, persistent profile
```bash
export DISPLAY=:99
Xvfb :99 -screen 0 1280x900x24 &
fluxbox &
mkdir -p /home/ec2-user/fb-profiles/burner
google-chrome-stable \
  --user-data-dir=/home/ec2-user/fb-profiles/burner \
  --proxy-server=http://<PROXY_HOST>:<PROXY_PORT> \
  --remote-debugging-port=9222 \
  --window-size=1280,900 \
  --no-first-run --no-default-browser-check \
  https://www.facebook.com/ &
```
Key points: **headful** (no `--headless`), **plain `--proxy-server`** (no selenium-wire, no auth extension), **persistent `--user-data-dir`**.

## Step 4 — Verify egress IP through the SAME Chrome (not just curl)
With the browser up, drive CDP (or just open a tab) to `https://api.ipify.org` and confirm the browser itself egresses the residential IP. (Chrome occasionally bypasses proxies for some traffic; this confirms FB traffic goes through it.)

## Step 5 — Interactive login via noVNC (the riskiest moment)
Expose the VNC session and log the burner in by hand (this is the new-IP + new-fingerprint moment FB scrutinizes most):
```bash
sudo /opt/scraper/scripts/ec2-expose-vnc.sh   # or x11vnc -display :99 -localhost -nopw + SSM port-forward
```
Connect via the SSM tunnel, open noVNC, log into Facebook, solve any captcha/checkpoint by hand. Land on the home feed.

## Step 6 — Park it and check the session holds for 48h
Leave Chrome + Xvfb running. Every few hours, reload the home feed and check the same signals the production code uses:
- `_page_is_logged_in` equivalent: feed renders, left sidebar present, no login form.
- `_url_is_login_or_checkpoint` equivalent: URL is NOT `/login` or `/checkpoint`, no "Continue as <name>" trust-gate loop.

`ec2-fb-session-check-profile.sh` is the existing checker — point it at the burner profile to automate the poll.

---

## PASS / FAIL — the decision this spike exists to make
- **PASS** = home feed holds, no checkpoint, for 48h, on Linux, through the residential IP.
  → Phase 1 targets **Linux EC2** (`ALLOW_SOCIAL_ON_LINUX=1`, `RESIDENTIAL_PROXY_MODE=whitelist`).
- **FAIL** (checkpoint, forced re-login, or trust-gate loop) = repeat Steps 2–6 **identically on the Windows EC2 box** (`i-0a373a528fdf851ff`) using `ec2-windows-spawn-cdp.ps1` / `ec2-windows-spawn-noVNC.ps1` as the launch path.
  → Whichever OS passes becomes the keystone host. The Phase 1 code is OS-parameterized (`FB_PROFILES_ROOT` + per-OS spawner) so the host is a drop-in choice; nothing downstream changes.

## Secondary cheap tests to run while the session is parked
- **Geo correctness** (Step 1/4) — already covered.
- **Cross-account correlation:** log a SECOND burner in on the same box but a DIFFERENT residential IP; over 24h see whether FB checkpoints either (tests whether one box hosting many accounts gets correlated).

## What to record
Append the result (PASS/FAIL, which OS, how long it held, any checkpoint reason, the egress IP/geo) to a dated note here in `docs/superpowers/specs/`. That note unblocks Phase 1.

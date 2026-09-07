# Running a second project on the scraper EC2 boxes

**Audience:** an agent or operator working on a *different* project who wants to host
work on one of the two EC2 instances this project already owns.

**Read the "Do not touch" list before running anything.** Both boxes carry state that
cannot be re-provisioned by re-running a script — specifically a logged-in Facebook
session tied to one machine fingerprint and one sticky residential IP. Losing it costs
days, not minutes.

---

## 1. The two boxes

| | `ec2-sg-1` (Linux) | `fb-scraper-win` (Windows) |
|---|---|---|
| Instance | `i-0188e136ef92d0c07` | `i-0a373a528fdf851ff` |
| Region | `ap-southeast-1` | `ap-southeast-1` |
| Repo | `/opt/scraper` (owner: `scraper`) | `C:\scraper` |
| Worker | `scraper-worker.service` (systemd) | `scraper-worker` + `scraper-worker-yelp` (NSSM) |
| Worker IDs | `ec2-sg-1` | `windows-fb-worker-1`, `windows-yelp-worker-1` |
| Deploy loop | root cron, 5 min → `/opt/scraper/scripts/deploy-ec2.sh` | Task Scheduler `scraper-deploy`, 5 min → `C:\scraper\scripts\ec2-windows-deploy.ps1` |
| Deploy state | `/var/lib/scraper-deploy/`, `/var/log/scraper-deploy.log` | `C:\scraper-deploy\` |
| Root disk | 80 GiB (grown from 8) | 80 GiB (grown from 30) |
| Irreplaceable state | none | AdsPower profiles, `C:\fb-profiles\<account_id>`, sticky proxy binding |

Access to both is **AWS SSM Session Manager — no SSH key exists**:

```bash
aws ssm start-session --target i-0188e136ef92d0c07 --region ap-southeast-1
```

---

## 2. Pick the right host (decision gate)

Answer these before doing anything else.

**Does your workload open a browser (headed or headless), or does it need a clean /
reputable egress IP?**

- **No** → use **`ec2-sg-1` (Linux)**. Its deploy script is already parameterized for
  multi-tenancy. Continue to §4.
- **Yes, but only headless HTTP scraping of low-defence targets** → `ec2-sg-1`, but read
  the IP warning in §3.

**`ec2-sg-1` is not an idle box, despite having no Windows GUI.** It claims every
platform except Facebook and Instagram (`PLATFORM_EXCLUDE=facebook,instagram`, plus
`BROWSERLESS_FB_OK=1` for consumer-mode Facebook), and it runs **headed Chrome under
Xvfb `:99` + fluxbox + x11vnc** for the Yelp relay path. It also has an egress-IP
identity of its own: the Yelp relay mints a DataDome cookie bound to that IP and reuses
it, and Trustpilot sits behind AWS WAF. Treat its IP reputation as load-bearing, not
disposable.
- **Yes, headed browser** → **do not share either box.** Provision your own instance.
  The Windows box runs headed Chrome under AdsPower and is CPU-bound already; the Linux
  box is checkpointed by Facebook and Instagram, which is why the Windows box exists at
  all. A t3.medium is roughly $30/month — cheaper than one debugging session on a
  cross-contaminated account.

**Never choose the Windows box** unless you specifically need AdsPower or a
Windows-only dependency. If you do, §5 covers it.

### Pre-flight — confirm there is actually headroom

```bash
# On your workstation
aws ec2 describe-instances --instance-ids i-0188e136ef92d0c07 --region ap-southeast-1 \
  --query 'Reservations[].Instances[].[InstanceType,State.Name]' --output text

# Inside the box
df -h /                                  # need >40% free before adding a tenant
free -m                                  # need >800 MB available
nproc && uptime                          # load average must be < nproc
systemctl is-active scraper-worker.service
```

If the disk is above 60% used, **stop and reclaim space first**. Out-of-disk is the
single most common failure on both boxes and its signature is deceptive — see §6.

---

## 3. Do not touch

Violating any of these has already caused a real outage on these boxes.

1. **Never `git pull`, `git checkout`, or commit inside `/opt/scraper` or `C:\scraper`.**
   The deploy loop uses `git pull --ff-only`. Any local commit or branch switch makes
   the pull refuse forever, and it fails *silently* — the box just serves stale code.
   This parked the Facebook worker for six days in June 2026. Clone your project into
   its own directory.

2. **Never reuse `WORKER_ID`,** and never point a worker at this project's Supabase
   queue with a `PLATFORM_FILTER` an existing worker also claims. The claim RPC is an
   exact single-match; two workers with overlapping filters steal each other's jobs. A
   stray worker on a laptop racing `ec2-sg-1` for the same queue is a bug we've already
   shipped and reverted.

3. **Never restart, stop, or reconfigure `scraper-worker`, `scraper-worker.service`, or
   `scraper-worker-yelp`** to free resources. Cap *your own* service instead (§4.4 /
   §5.4). Restarting the worker mid-scrape kills its Python subprocesses and the job
   dies with `Script exited with code null`.

4. **On Windows: never touch AdsPower, `C:\fb-profiles\*`, the proxy configuration, or
   the installed Chrome/Chromium version.** The Facebook path pins
   `SOCIAL_CHROME_VERSION=148`. A global browser upgrade breaks the fingerprint and
   forces a manual re-login through a GUI session.

5. **Never route your traffic through this project's residential proxy, and don't
   scrape from the Windows box's IP.** That IP and its sticky session *are* the
   Facebook account's identity. Getting it rate-flagged or blacklisted by unrelated
   scraping is not recoverable by restarting anything.

6. **Don't `apt upgrade` / `choco upgrade all`, and don't change the global Node or
   Python version.** Pin your own runtime inside your own directory (`nvm`, a venv)
   instead.

---

## 4. Linux co-tenancy — `ec2-sg-1`

The Linux deploy script is already env-parameterized, so you can reuse it verbatim
rather than writing your own. Substitute your project's short name for `proj2`
throughout.

### 4.1 Own user, own directory

```bash
sudo useradd -r -m -d /opt/proj2 -s /bin/bash proj2
sudo -u proj2 git clone https://github.com/you/proj2.git /opt/proj2
```

Do **not** run as the existing `scraper` user. Its sudoers grants and file ownership are
what let the other deploy loop work; sharing it means your build can leave files the
`scraper` user can no longer write, which breaks that loop.

### 4.2 Own systemd unit

`/etc/systemd/system/proj2-worker.service`:

```ini
[Unit]
Description=proj2 worker
After=network-online.target

[Service]
Type=simple
User=proj2
WorkingDirectory=/opt/proj2
EnvironmentFile=/etc/proj2-worker.env
ExecStart=/usr/bin/node /opt/proj2/dist/worker.js
Restart=always
RestartSec=5

# Resource fencing — the new tenant is the one that gets limited, never the incumbent.
CPUQuota=50%
MemoryHigh=768M
MemoryMax=1G
Nice=10
IOWeight=50

[Install]
WantedBy=multi-user.target
```

`CPUQuota` and `MemoryMax` are the whole point of this file. Without them a runaway
build or a leaking browser starves the incumbent worker, and the symptom shows up as
*that* project's jobs timing out — you will get blamed for a bug that looks like theirs.

```bash
sudo touch /etc/proj2-worker.env && sudo chmod 600 /etc/proj2-worker.env
# put your secrets in it, then:
sudo systemctl daemon-reload && sudo systemctl enable --now proj2-worker.service
```

### 4.3 Own deploy loop

Copy `scripts/deploy-ec2.sh` from this project into yours. It reads `REPO_DIR`,
`SCRAPER_USER`, `SERVICE_NAME`, `LOG_FILE`, `LOCK_FILE` and `STATE_DIR` from the
environment, so those need no code change.

**Two values are hardcoded and you must edit them in your copy:**

- the busy-job guard queries `worker_id=eq.ec2-sg-1` — change it to your worker id, or
  delete the whole guard block if your worker has no long-running jobs to protect;
- it sources `/etc/scraper-worker.env` — change it to `/etc/proj2-worker.env`.

Leave that copy in your own repo. Then a wrapper, `/usr/local/bin/proj2-deploy`:

```bash
#!/usr/bin/env bash
export REPO_DIR=/opt/proj2 SCRAPER_USER=proj2 SERVICE_NAME=proj2-worker.service
export LOG_FILE=/var/log/proj2-deploy.log LOCK_FILE=/var/lock/proj2-deploy.lock
export STATE_DIR=/var/lib/proj2-deploy
exec /opt/proj2/scripts/deploy-ec2.sh
```

```bash
sudo chmod +x /usr/local/bin/proj2-deploy
echo '*/5 * * * * root /usr/local/bin/proj2-deploy' | sudo tee /etc/cron.d/proj2-deploy
```

Use a wrapper rather than inlining the variables in the crontab line — cron's command
field has its own `%` escaping rules and the inline form is easy to get subtly wrong.
Distinct `LOCK_FILE` and `STATE_DIR` values are mandatory: sharing them means one
project's `flock` silently cancels the other project's deploys.

### 4.4 Disk guard — fail your tenant, not the host

Both boxes have run out of disk before. Add a guard that stops **your** service when the
volume gets tight, so the incumbent survives:

```bash
sudo tee /usr/local/bin/proj2-disk-guard >/dev/null <<'EOF'
#!/usr/bin/env bash
USED=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$USED" -ge 90 ]; then
  logger -t proj2-disk-guard "root fs ${USED}% — stopping proj2-worker to protect the host"
  systemctl stop proj2-worker.service
fi
EOF
sudo chmod +x /usr/local/bin/proj2-disk-guard
echo '*/5 * * * * root /usr/local/bin/proj2-disk-guard' | sudo tee /etc/cron.d/proj2-disk-guard
```

Keep your scratch files under your own tree (`/opt/proj2/.tmp`) with a prune job, and
cap the journal once: `sudo journalctl --vacuum-size=500M`.

### 4.5 Verify you broke nothing

```bash
systemctl is-active scraper-worker.service          # still active
tail -20 /var/log/scraper-deploy.log                # incumbent deploys still running
sudo -u scraper git -C /opt/scraper status --short   # must be EMPTY
df -h / && free -m                                   # headroom still there
```

Then watch for a full day. The failure modes here are all slow: disk creep, a deploy
loop that stopped firing, a worker that claims jobs more slowly under CPU contention.

---

## 5. Windows co-tenancy — `fb-scraper-win`

Only if you genuinely need this box. The two existing services already share
`C:\scraper`, so multi-service hosting is a proven pattern here — but a *different
project* gets its own directory.

### 5.1 Own directory

```powershell
git clone https://github.com/you/proj2.git C:\proj2
```

Never `C:\scraper`.

### 5.2 Own deploy task

Copy `scripts/ec2-windows-deploy.ps1` into your repo. **Unlike the Linux script it is
not env-parameterized** — edit the four variables at the top:

```powershell
$REPO_DIR     = "C:\proj2"
$SERVICE_NAME = "proj2-worker"
$STATE_DIR    = "C:\proj2-deploy"
# $LOG_FILE / $LOCK_FILE / $ATTEMPTED derive from $STATE_DIR
```

**Keep the PATH-refresh block near the top of that script.** Task Scheduler runs with a
stale `PATH`; without the refresh every `git` call exits with `$LASTEXITCODE` unset, both
sides of the HEAD comparison are empty strings, the comparison passes, and the script
no-ops at "nothing new" on every tick. That hid a broken deploy for hours.

Register under a **distinct task name** — never `scraper-deploy`:

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"C:\proj2\scripts\proj2-deploy.ps1`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "proj2-deploy" -Action $action -Trigger $trigger `
  -User "SYSTEM" -RunLevel Highest
```

### 5.3 Own NSSM service

```powershell
nssm install proj2-worker "C:\Program Files\nodejs\node.exe" "C:\proj2\dist\worker.js"
nssm set proj2-worker AppDirectory "C:\proj2"
nssm set proj2-worker AppStdout "C:\proj2\logs\worker.log"
nssm set proj2-worker AppStderr "C:\proj2\logs\worker.err.log"
nssm set proj2-worker AppRotateFiles 1
nssm set proj2-worker AppRotateOnline 1
nssm set proj2-worker AppRotateBytes 10485760
nssm set proj2-worker AppExit Default Restart
nssm set proj2-worker AppRestartDelay 5000
nssm set proj2-worker Start SERVICE_AUTO_START
```

Distinct log filenames matter — the existing services write `worker.log` and
`worker-yelp.log` under `C:\scraper\server\logs`, and NSSM's rotation does not
coordinate between services writing the same file.

### 5.4 Resource fencing and logon account

```powershell
nssm set proj2-worker AppPriority BELOW_NORMAL_PRIORITY_CLASS
```

NSSM has no CPU quota, so priority is the only lever — it is weaker than systemd's
`CPUQuota`, which is another reason to prefer the Linux box.

Run as `LocalSystem` (the NSSM default). The incumbent services run as
`.\Administrator` because a headed browser needs an interactive-ish session; **do not
copy that** unless you need it, and never store the Administrator password in your repo.

### 5.5 Verify you broke nothing

```powershell
Get-Service scraper-worker, scraper-worker-yelp        # both Running
git -C C:\scraper status --short                       # must be EMPTY
Get-Content C:\scraper-deploy\deploy.log -Tail 20      # incumbent loop still ticking
Get-ScheduledTask -TaskName scraper-deploy             # still Ready
Get-PSDrive C                                          # free space
Get-Process chrome, chromedriver -ErrorAction SilentlyContinue | Measure-Object
```

---

## 6. Failure signatures worth memorizing

These have all happened on these boxes. Recognizing them saves hours.

**Out of disk looks like a code bug, not a disk problem.** Reads keep working while
writes fail, so the worker still claims jobs in about a second, Chromium dies in about
two, SSM Run Command returns zero bytes with rc 1, and Session Manager draws no prompt.
On the Windows box, AdsPower silently refuses to open profiles and browse sessions go
`provisioning` → `ended` with no tunnel and no error — which reads as a frontend or
worker bug and is not one. **Check `df -h /` / `Get-PSDrive C` first, always.** Note
that growing an EBS volume is not enough on Linux: you must reboot so cloud-init expands
the filesystem.

**A silently stale deploy loop.** The box serves old code while every cron tick exits 0.
Causes seen: a local commit or branch switch defeating `--ff-only`; a stale `PATH` under
Task Scheduler; a shared `flock` target; and a `grep` no-match exit propagating through
`set -o pipefail` and aborting the script before it logged anything (that one froze
deploys for four days). Diagnose by comparing `git -C <repo> rev-parse HEAD` against
`origin/main`, not by reading the log — a broken loop writes nothing.

**Jobs vanishing.** Two workers with overlapping `PLATFORM_FILTER` values, or duplicate
`WORKER_ID`s, on the same queue.

**CPU starvation reads as a hung process.** On a 1–2 vCPU box, heartbeat `setInterval`
timers stop firing under load, a stale-claim sweeper then requeues the job, and a
watchdog stamps the still-running work as `failed`. If your tenant is uncapped, you will
cause this in the incumbent project. Cap it (§4.2 / §5.4).

---

## 7. Rollback

Full removal of a Linux tenant, leaving the box as it was:

```bash
sudo systemctl disable --now proj2-worker.service
sudo rm -f /etc/systemd/system/proj2-worker.service /etc/proj2-worker.env
sudo rm -f /etc/cron.d/proj2-deploy /etc/cron.d/proj2-disk-guard
sudo rm -f /usr/local/bin/proj2-deploy /usr/local/bin/proj2-disk-guard
sudo rm -rf /opt/proj2 /var/lib/proj2-deploy /var/log/proj2-deploy.log
sudo systemctl daemon-reload
sudo userdel proj2
```

Windows:

```powershell
nssm stop proj2-worker; nssm remove proj2-worker confirm
Unregister-ScheduledTask -TaskName proj2-deploy -Confirm:$false
Remove-Item -Recurse -Force C:\proj2, C:\proj2-deploy
```

Because every artifact above is namespaced, rollback touches nothing the incumbent
project owns. That is the property to preserve if you deviate from this guide.

---

## 8. Worked example — automated content generator + link-building publisher

This is the concrete case the guide was written for: a Python app that generates
articles and publishes them both to sites we own and to third-party outreach
placements, across roughly 80 target platforms, using platform APIs where they exist
and browser automation into the editor where they don't.

**Do not host it as one unit.** Split it by *risk of losing an account*, not by
convenience, because the three parts have completely different exposure.

| Tier | Work | Host | Why |
|---|---|---|---|
| A. Generation | LLM calls, article assembly, DB writes | **`ec2-sg-1`, co-hosted** per §4 | HTTP-out only. No inbound reputation, no login sessions, nothing to ban. This is where sharing genuinely saves money. |
| B. Own-network publishing | WordPress REST / XML-RPC to sites we control | **`ec2-sg-1`, co-hosted** per §4 | Our CMS, our credentials, no ban surface. |
| C. Outreach publishing | Third-party placements, browser fallback, per-platform logins | **Its own host, its own IPs** | Account bans are the whole risk model. Must never share an IP with the scraper. |

### Why B is safe to co-host but C is not

For API publishing to sites we own, **the egress IP of the machine making the REST call
is invisible to search engines.** They see the published page, not who POSTed it. An
owned network's SEO footprint lives in hosting IPs, DNS and registrar data, template
reuse, interlinking patterns and publish cadence — none of which the publisher's own IP
touches. So Tier B can share a box freely.

Tier C is the opposite. Third-party platforms *do* log the IP that logged in and posted,
and a backlink-dropping session is exactly what their WAFs score as spam. Two
consequences:

1. **Shared-fate with the scraper.** `ec2-sg-1`'s IP is load-bearing: the Yelp relay
   path mints a DataDome cookie bound to that egress IP and reuses it, and Trustpilot
   sits behind AWS WAF. One spam flag from publishing burns the scraper's cookie; one
   WAF listing from scraping burns the publishing accounts. You will not be able to tell
   which side caused it.
2. **Footprint across the campaign.** Eighty aged platform accounts all posting from one
   AWS datacenter IP in Singapore is a single correlation point. That is the pattern
   platform-side spam review looks for, and those accounts are the campaign's actual
   asset — far more expensive to replace than a second VPS.

### Wiring A+B as a co-tenant, C as a remote worker

Give the publisher a queue table of its own with a channel column, then run two workers
with **disjoint** filters — the same pattern this project uses for `PLATFORM_FILTER`,
and subject to the same failure mode (overlapping filters steal each other's jobs, §3.2):

| Worker | Host | Claims |
|---|---|---|
| `contentgen-worker` | `ec2-sg-1` (capped per §4.2) | `channel = 'own_network'` + all generation rows |
| `outreach-worker` | isolated box | `channel = 'outreach'` |

Use distinct worker ids and make the two filters provably disjoint — not "different by
convention". If a platform is API-capable, route it to `own_network` even if it's
third-party-hosted: no login session means no ban surface, which is what actually
decides the tier.

**If the publisher uses this project's Supabase, give it its own tables.** Do not put
publishing jobs in `scrape_jobs` — the scraper workers and a 10-minute stale-claim
sweeper both operate on that table.

### The outreach box

- **Anything cheap works** — it does not need to be AWS or in Singapore. A small VPS is
  fine; compute is not the constraint here.
- **Proxies are the real budget line, and they must be segmented.** Do not put 80
  accounts behind one residential exit — that just relocates the shared-footprint
  problem. Group platforms and pin a sticky session per group. Note the lesson this
  project already paid for: on the residential provider in use, only the
  `_session-<id>` form holds one IP; a plain session rotates the exit on **every
  request**, which reads to the target as an account hopping countries mid-session.
- **Budget for the 80-profile disk trap.** Per-platform browser profiles with caches are
  exactly how `fb-scraper-win` filled a 30 GiB volume twice. Put profiles on their own
  volume or path, prune caches on a schedule, and install the §4.4 disk guard from day
  one rather than after the first silent outage.
- **Expect checkpoints to be routine,** not exceptional. Build the recovery path — a way
  for an operator to complete a login challenge by hand and hand the session back — into
  the first version. Retrofitting it is how the Facebook side lost days.

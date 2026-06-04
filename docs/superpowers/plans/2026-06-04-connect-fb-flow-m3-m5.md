# Connect Facebook Flow — M3-M5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the end-to-end Connect Facebook cross-host flow — operator clicks Connect Facebook in the dashboard, drives a remote Brave session on the Windows EC2 worker via noVNC in a new browser tab, and the cookies land encrypted in `social_accounts` automatically when the FB session cookie appears.

**Architecture:** Database is the message bus between Cloud Run and Windows EC2. Cloud Run never talks directly to the EC2. Three independently-shippable milestones: M3 (Cloud Run route refactor — DB writes + polling endpoint), M4 (EC2 worker poll loop + PowerShell launcher script), M5 (frontend modal that polls and opens the tunnel URL in a new tab).

**Tech Stack:** Express + TypeScript (Cloud Run), Next.js + React (Vercel frontend), Node child_process + PowerShell (EC2 worker), `crypto.createCipheriv` for cookie encryption (existing `server/src/lib/encryption.ts`), noVNC + cloudflared (one-time Windows install).

---

## Already done

- M1: pytest regression suite (commit 99956d6)
- M2: migration 044 applied to Supabase — `social_accounts` now has `connect_session_id`, `connect_tunnel_url`, `connect_status`, `connect_started_at`, `connect_expires_at`, `connect_error` columns + 2 partial indexes

## What ships in this plan

| Task | Files | Risk |
|---|---|---|
| **T1**: Reuse-check + claim helper | new `server/src/db/social-connect-requests.ts` | Low — new file |
| **T2**: Cloud Run route refactor (M3) | modify `server/src/routes/social-accounts.ts` | Medium — replaces existing SSE spawner |
| **T3**: EC2 worker poll loop (M4 — TS half) | new `server/src/worker/social-connect-worker.ts` + register in `server.ts` | Low — new file, only runs on the box where `ENABLE_SOCIAL_CONNECT_WORKER=1` |
| **T4**: PowerShell spawn-noVNC script (M4 — Windows half) | new `scripts/ec2-windows-spawn-noVNC.ps1` | Low — new file, operator reviews before first run |
| **T5**: Frontend modal (M5) | modify `frontend/src/views/SocialAccounts.tsx` | Medium — replaces existing SSE-driven Connect UI |

After T1-T5 ship, the operator does the one-time **manual EC2 install** (noVNC + cloudflared binaries) and runs end-to-end test.

---

## File structure

```
server/
├── src/
│   ├── routes/
│   │   └── social-accounts.ts        ← MODIFY: replace SSE spawn with DB writes
│   ├── db/
│   │   └── social-connect-requests.ts ← NEW: helpers for the connect_* columns
│   ├── worker/
│   │   ├── scraper-worker.ts          ← reference for poll pattern, not modified
│   │   └── social-connect-worker.ts   ← NEW: poll + claim + spawn + watch cookies
│   ├── lib/
│   │   └── encryption.ts              ← reused, not modified (encryptCookie/decryptCookie)
│   └── server.ts                      ← MODIFY: register social-connect-worker if env flag set
├── __tests__/
│   └── social-connect-requests.test.ts ← NEW: vitest unit tests for the helpers

scripts/
└── ec2-windows-spawn-noVNC.ps1        ← NEW: starts VNC + websockify + cloudflared + Brave

frontend/
└── src/views/
    └── SocialAccounts.tsx              ← MODIFY: SSE-stream → polling + window.open
```

---

## Task 1: DB helpers for connect-flow columns

**Files:**
- Create: `server/src/db/social-connect-requests.ts`
- Test: `server/src/__tests__/social-connect-requests.test.ts`

The helpers are pure SQL wrappers — easy to test by mocking the Supabase client. Keep the table-shaped types in this file so the worker + route both import the same shapes.

- [ ] **Step 1.1: Write the failing test**

Create `server/src/__tests__/social-connect-requests.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as supabaseMod from '../lib/supabase.js';
import {
  enqueueConnectRequest,
  getConnectRequestStatus,
  claimPendingConnectRequest,
  finalizeConnectRequest,
} from '../db/social-connect-requests.js';

function makeMockSupabase(impl: Record<string, any>) {
  return {
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: impl.updateResult, error: null }),
            }),
            select_no_eq: vi.fn(),
          }),
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: impl.updateResult, error: null }),
          }),
        }),
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: impl.selectResult, error: null }),
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: impl.selectResult, error: null }),
          }),
        }),
      }),
    }),
  };
}

describe('enqueueConnectRequest', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('writes connect_status=requested with a fresh session id and 10-min expiry', async () => {
    const fakeRow = { id: 'a1', connect_session_id: 'sess-1', connect_status: 'requested' };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(
      makeMockSupabase({ updateResult: fakeRow }) as any,
    );
    const result = await enqueueConnectRequest('a1');
    expect(result.connect_status).toBe('requested');
    expect(result.connect_session_id).toBe('sess-1');
  });
});

describe('getConnectRequestStatus', () => {
  it('returns the current status + tunnel URL', async () => {
    const fakeRow = {
      connect_status: 'ready',
      connect_tunnel_url: 'https://test.trycloudflare.com',
      connect_error: null,
      connect_expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(
      makeMockSupabase({ selectResult: fakeRow }) as any,
    );
    const result = await getConnectRequestStatus('a1');
    expect(result.connect_status).toBe('ready');
    expect(result.connect_tunnel_url).toBe('https://test.trycloudflare.com');
  });
});
```

- [ ] **Step 1.2: Run test, verify it fails**

Run: `cd server && npx vitest run src/__tests__/social-connect-requests.test.ts`
Expected: FAIL with `Cannot find module '../db/social-connect-requests.js'`

- [ ] **Step 1.3: Implement the helpers**

Create `server/src/db/social-connect-requests.ts`:

```typescript
import crypto from 'crypto';
import { getSupabase } from '../lib/supabase.js';

export type ConnectStatus =
  | 'requested' | 'provisioning' | 'ready' | 'captured' | 'expired' | 'failed';

export interface ConnectRequestRow {
  id: string;
  connect_session_id: string | null;
  connect_status: ConnectStatus | null;
  connect_tunnel_url: string | null;
  connect_started_at: string | null;
  connect_expires_at: string | null;
  connect_error: string | null;
}

export interface ConnectStatusView {
  connect_status: ConnectStatus | null;
  connect_tunnel_url: string | null;
  connect_error: string | null;
  connect_expires_at: string | null;
}

const TTL_MS = 10 * 60 * 1000;

export async function enqueueConnectRequest(accountId: string): Promise<ConnectRequestRow> {
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MS);
  const { data, error } = await getSupabase()
    .from('social_accounts')
    .update({
      connect_session_id: sessionId,
      connect_status: 'requested' as ConnectStatus,
      connect_tunnel_url: null,
      connect_started_at: now.toISOString(),
      connect_expires_at: expires.toISOString(),
      connect_error: null,
    })
    .eq('id', accountId)
    .select('id, connect_session_id, connect_status, connect_tunnel_url, connect_started_at, connect_expires_at, connect_error')
    .single();
  if (error) throw new Error(`enqueueConnectRequest: ${error.message}`);
  return data as ConnectRequestRow;
}

export async function getConnectRequestStatus(accountId: string): Promise<ConnectStatusView> {
  const { data, error } = await getSupabase()
    .from('social_accounts')
    .select('connect_status, connect_tunnel_url, connect_error, connect_expires_at')
    .eq('id', accountId)
    .single();
  if (error) throw new Error(`getConnectRequestStatus: ${error.message}`);
  return data as ConnectStatusView;
}

// Worker-side: pick the oldest 'requested' row for this platform, atomically
// transition it to 'provisioning' to prevent double-claim. Returns null when
// no pending requests exist.
export async function claimPendingConnectRequest(platform: string): Promise<ConnectRequestRow | null> {
  const sb = getSupabase();
  const { data: candidates, error: selectErr } = await sb
    .from('social_accounts')
    .select('id, connect_session_id, connect_status, connect_tunnel_url, connect_started_at, connect_expires_at, connect_error')
    .eq('platform', platform)
    .eq('connect_status', 'requested')
    .order('connect_started_at', { ascending: true })
    .limit(1);
  if (selectErr) throw new Error(`claimPendingConnectRequest select: ${selectErr.message}`);
  const candidate = (candidates as ConnectRequestRow[] | null)?.[0];
  if (!candidate) return null;

  // Optimistic claim — only succeeds if the row is STILL 'requested' with
  // the same session_id. If another worker grabbed it first, this returns 0
  // rows and we just try again next tick.
  const { data: claimed, error: updateErr } = await sb
    .from('social_accounts')
    .update({ connect_status: 'provisioning' as ConnectStatus })
    .eq('id', candidate.id)
    .eq('connect_session_id', candidate.connect_session_id ?? '')
    .eq('connect_status', 'requested')
    .select('id, connect_session_id, connect_status, connect_tunnel_url, connect_started_at, connect_expires_at, connect_error')
    .single();
  if (updateErr) {
    // PGRST116 = no rows matched the WHERE — someone else claimed it. Not an error.
    if ((updateErr as { code?: string }).code === 'PGRST116') return null;
    throw new Error(`claimPendingConnectRequest update: ${updateErr.message}`);
  }
  return claimed as ConnectRequestRow;
}

export async function updateConnectStatus(
  accountId: string,
  patch: Partial<Pick<ConnectRequestRow, 'connect_status' | 'connect_tunnel_url' | 'connect_error'>>,
): Promise<void> {
  const { error } = await getSupabase()
    .from('social_accounts')
    .update(patch)
    .eq('id', accountId);
  if (error) throw new Error(`updateConnectStatus: ${error.message}`);
}

// Final step on a successful capture — writes encrypted cookies AND flips
// the account to 'active', AND marks the connect row 'captured'. One atomic
// update so a partial failure can't leave a 'captured' row without cookies.
export async function finalizeConnectRequest(
  accountId: string,
  encryptedCookies: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from('social_accounts')
    .update({
      encrypted_cookies: encryptedCookies,
      status: 'active',
      connect_status: 'captured' as ConnectStatus,
      last_login_at: new Date().toISOString(),
    })
    .eq('id', accountId);
  if (error) throw new Error(`finalizeConnectRequest: ${error.message}`);
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/social-connect-requests.test.ts`
Expected: 2 tests pass.

- [ ] **Step 1.5: TypeScript check**

Run: `cd server && npx tsc --noEmit`
Expected: clean (no output).

- [ ] **Step 1.6: Commit**

```bash
git add server/src/db/social-connect-requests.ts server/src/__tests__/social-connect-requests.test.ts
git commit -m "feat(db): helpers for social_accounts connect-flow columns"
```

---

## Task 2: Cloud Run route refactor (M3)

**Files:**
- Modify: `server/src/routes/social-accounts.ts:248-263` (replace the `/connect` SSE handler)

Replace the spawn-Python-locally SSE handler with: write a row, return 202. Add a new GET endpoint the frontend polls. Keep `/recover` untouched — it still streams the local Python recovery flow which only runs on the operator's laptop and is fine as-is.

- [ ] **Step 2.1: Replace the /connect handler**

Open `server/src/routes/social-accounts.ts`. Find the section from `// ── POST /api/social-accounts/:id/connect (SSE)` through the end of that handler. Replace this block:

```typescript
// ── POST /api/social-accounts/:id/connect (SSE) ──────────────────────
// Body may include { username, password } for autofill — both optional;
// when present, the Python child uses them once to pre-fill the form and
// then discards them.
router.post('/:id/connect', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { username?: string; password?: string };
  streamLoginFlow(String(req.params.id), false, req, res, {
    username: body.username,
    password: body.password,
  });
});
```

With:

```typescript
// ── POST /api/social-accounts/:id/connect ────────────────────────────
// Writes a connect-request row to social_accounts. The Windows EC2
// worker polls for these rows, spawns a remote Brave + noVNC + cloud-
// flared session, and reports the public tunnel URL back via the
// connect_tunnel_url column. The frontend polls GET /:id/connect-status
// for that URL and opens it in a new tab.
router.post('/:id/connect', async (req: Request, res: Response) => {
  try {
    const row = await enqueueConnectRequest(String(req.params.id));
    res.status(202).json({
      success: true,
      data: {
        connect_session_id: row.connect_session_id,
        connect_status: row.connect_status,
        connect_expires_at: row.connect_expires_at,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ── GET /api/social-accounts/:id/connect-status ──────────────────────
// Frontend polls this every ~2s while a connect modal is open.
router.get('/:id/connect-status', async (req: Request, res: Response) => {
  try {
    const view = await getConnectRequestStatus(String(req.params.id));
    res.json({ success: true, data: view });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});
```

Add the import at the top of the file (find the `import` block, append):

```typescript
import { enqueueConnectRequest, getConnectRequestStatus } from '../db/social-connect-requests.js';
```

- [ ] **Step 2.2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2.3: Smoke-test the new endpoint locally**

Start the API: `cd server && npm run dev` (if not already running).

In another terminal:
```bash
# Use one of the existing social_accounts UUIDs — pull from DB
ACCOUNT_ID=0eec969c-a888-4e54-bdfe-057ca11c2af5
curl -s -X POST http://localhost:3001/api/social-accounts/$ACCOUNT_ID/connect | jq .
curl -s http://localhost:3001/api/social-accounts/$ACCOUNT_ID/connect-status | jq .
```

Expected: first returns `{success: true, data: {connect_session_id: <uuid>, connect_status: "requested", ...}}`. Second returns `{success: true, data: {connect_status: "requested", connect_tunnel_url: null, ...}}`.

- [ ] **Step 2.4: Commit**

```bash
git add server/src/routes/social-accounts.ts
git commit -m "feat(api): /connect writes DB row; /connect-status polled endpoint"
```

---

## Task 3: EC2 worker poll loop (M4 — TS half)

**Files:**
- Create: `server/src/worker/social-connect-worker.ts`
- Modify: `server/src/server.ts` (register the worker when `ENABLE_SOCIAL_CONNECT_WORKER=1`)

The worker is a long-running loop that mirrors the scraper-worker pattern. Each tick: claim → spawn PowerShell → capture tunnel URL → watch cookies → finalize.

- [ ] **Step 3.1: Create the worker**

Create `server/src/worker/social-connect-worker.ts`:

```typescript
/**
 * Social-Connect Worker — polls social_accounts for connect_status='requested',
 * spawns scripts/ec2-windows-spawn-noVNC.ps1 to launch Brave behind a public
 * cloudflared tunnel, watches Brave's cookies dir for the FB session cookie,
 * and finalizes by encrypting + writing the cookies back to the row.
 *
 * Only runs on the Windows EC2 worker (gated by ENABLE_SOCIAL_CONNECT_WORKER=1
 * env var so dev / Cloud Run instances don't accidentally enter the loop).
 *
 * Cross-host architecture: the database is the message bus. Cloud Run never
 * talks to this worker directly.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import {
  ConnectRequestRow,
  claimPendingConnectRequest,
  updateConnectStatus,
  finalizeConnectRequest,
} from '../db/social-connect-requests.js';
import { encryptCookie } from '../lib/encryption.js';

const POLL_INTERVAL_MS = 10_000;
const COOKIE_WATCH_INTERVAL_MS = 2_000;
const PROFILES_ROOT = process.env.FB_PROFILES_ROOT ?? 'C:\\fb-profiles';
const SPAWN_SCRIPT = path.join(process.cwd(), 'scripts', 'ec2-windows-spawn-noVNC.ps1');
const FB_SESSION_COOKIE = 'c_user';

let stopped = false;

function log(msg: string): void {
  console.log(`[social-connect-worker] ${msg}`);
}

async function handleRequest(row: ConnectRequestRow): Promise<void> {
  log(`claimed account=${row.id} session=${row.connect_session_id}`);
  const profileDir = path.join(PROFILES_ROOT, row.id);
  await fs.mkdir(profileDir, { recursive: true });

  // Spawn the PowerShell script which prints the tunnel URL to stdout on its
  // first non-blank line, then keeps running to host the noVNC + Brave session.
  const child = spawn(
    'powershell',
    [
      '-ExecutionPolicy', 'Bypass',
      '-File', SPAWN_SCRIPT,
      '-ProfileDir', profileDir,
      '-AccountId', row.id,
    ],
    { windowsHide: true },
  );

  let tunnelUrl: string | null = null;
  let finalized = false;

  child.stdout.on('data', async (buf: Buffer) => {
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      log(`[ps stdout] ${trimmed.slice(0, 200)}`);
      // First trycloudflare.com URL we see is the public tunnel.
      if (!tunnelUrl) {
        const match = trimmed.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) {
          tunnelUrl = match[0];
          await updateConnectStatus(row.id, {
            connect_status: 'ready',
            connect_tunnel_url: tunnelUrl,
          });
          log(`tunnel ready: ${tunnelUrl}`);
        }
      }
    }
  });

  child.stderr.on('data', (buf: Buffer) => {
    log(`[ps stderr] ${buf.toString('utf8').slice(0, 200).trim()}`);
  });

  // Watch Brave's Cookies SQLite for the c_user marker. The cookies live at
  // <profileDir>\Default\Network\Cookies — a SQLite file. Polling its mtime
  // is enough; when it changes, run an extract.
  const cookiesPath = path.join(profileDir, 'Default', 'Network', 'Cookies');
  const watchInterval = setInterval(async () => {
    if (finalized) return;
    try {
      const stat = await fs.stat(cookiesPath);
      if (!stat.isFile()) return;
      // Read the cookies file in binary form and check for the marker. SQLite
      // stores strings as-is so a substring search works for our purposes.
      const buf = await fs.readFile(cookiesPath);
      if (!buf.includes(FB_SESSION_COOKIE)) return;
      // Capture. Encrypt the raw cookies file contents as the cookie jar — the
      // scraper side already reads it as-is via session_store.py.
      const encrypted = encryptCookie(buf.toString('base64'));
      await finalizeConnectRequest(row.id, encrypted);
      finalized = true;
      log(`captured cookies for account=${row.id}, killing browser`);
      child.kill();
      clearInterval(watchInterval);
    } catch (err) {
      // Cookies file may not exist yet — that's fine, will appear once Brave starts.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`cookies watch error: ${(err as Error).message}`);
      }
    }
  }, COOKIE_WATCH_INTERVAL_MS);

  // Expiry sweep — if we hit connect_expires_at without capturing, give up.
  const expiresAt = row.connect_expires_at ? new Date(row.connect_expires_at).getTime() : Date.now() + 600_000;
  const expirySweep = setInterval(async () => {
    if (finalized) return;
    if (Date.now() > expiresAt) {
      log(`account=${row.id} expired without capture`);
      await updateConnectStatus(row.id, {
        connect_status: 'expired',
        connect_error: 'login not completed within 10 minutes',
      });
      child.kill();
      clearInterval(watchInterval);
      clearInterval(expirySweep);
    }
  }, 5_000);

  child.on('exit', (code) => {
    clearInterval(watchInterval);
    clearInterval(expirySweep);
    if (!finalized) {
      // Browser/script died before we captured cookies. Mark failed unless we
      // already marked expired above.
      log(`script exited code=${code} before capture; marking failed`);
      void updateConnectStatus(row.id, {
        connect_status: 'failed',
        connect_error: `spawn script exited with code ${code}`,
      });
    }
  });
}

async function pollOnce(platform: string): Promise<void> {
  try {
    const row = await claimPendingConnectRequest(platform);
    if (!row) return;
    await handleRequest(row);
  } catch (err) {
    log(`poll error: ${(err as Error).message}`);
  }
}

export function startSocialConnectWorker(): void {
  if (process.env.ENABLE_SOCIAL_CONNECT_WORKER !== '1') {
    log('disabled (set ENABLE_SOCIAL_CONNECT_WORKER=1 to enable)');
    return;
  }
  log(`starting; polling every ${POLL_INTERVAL_MS}ms`);
  const timer = setInterval(() => { void pollOnce('facebook'); }, POLL_INTERVAL_MS);
  // First tick immediately.
  void pollOnce('facebook');
  process.on('SIGTERM', () => { stopped = true; clearInterval(timer); });
  process.on('SIGINT', () => { stopped = true; clearInterval(timer); });
}
```

- [ ] **Step 3.2: Register the worker in server.ts**

Open `server/src/server.ts`. Find the imports block and the existing worker startup. Add the import:

```typescript
import { startSocialConnectWorker } from './worker/social-connect-worker.js';
```

And in the startup function (look for where other workers/schedulers start — e.g. `[CampaignScheduler] Started`), add:

```typescript
startSocialConnectWorker();
```

- [ ] **Step 3.3: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3.4: Smoke-test in dev (worker stays disabled — no PowerShell)**

Start API: `cd server && npm run dev`
Expected log line: `[social-connect-worker] disabled (set ENABLE_SOCIAL_CONNECT_WORKER=1 to enable)`

This proves the import path works without actually running the worker on the dev machine (no PowerShell, no Brave, no EC2).

- [ ] **Step 3.5: Commit**

```bash
git add server/src/worker/social-connect-worker.ts server/src/server.ts
git commit -m "feat(worker): social-connect-worker polls + spawns noVNC + captures cookies"
```

---

## Task 4: PowerShell spawn-noVNC script (M4 — Windows half)

**Files:**
- Create: `scripts/ec2-windows-spawn-noVNC.ps1`

This script runs on the Windows EC2 each time the worker claims a connect request. It assumes the operator has already done the one-time install of TightVNC + websockify + cloudflared + Brave (see operator-install section at the bottom of this plan).

- [ ] **Step 4.1: Write the script**

Create `scripts/ec2-windows-spawn-noVNC.ps1`:

```powershell
# ec2-windows-spawn-noVNC.ps1
# Runs once per Connect-FB request. Spawned by social-connect-worker.ts.
# Starts in order:
#   1. TightVNC server (display only — VNC server itself runs as a service
#      and the listener is already on :5900)
#   2. websockify (translates noVNC websocket on :6080 to VNC :5900)
#   3. cloudflared tunnel pointing at :6080
#   4. Brave launched at facebook.com with the operator's profile dir
# Prints the tunnel URL on stdout. social-connect-worker.ts greps the
# first trycloudflare.com line and writes it to the DB row.
#
# Args:
#   -ProfileDir  C:\fb-profiles\<account_id>
#   -AccountId   the social_accounts.id (for log tagging)
#
# Process lifecycle: when the parent (Node) kills this script, we kill all
# spawned children. Brave / websockify / cloudflared are launched with
# Start-Process so we can track + clean up their PIDs.

param(
    [Parameter(Mandatory=$true)][string]$ProfileDir,
    [Parameter(Mandatory=$true)][string]$AccountId
)

$ErrorActionPreference = "Continue"

# Paths — operator-installed binaries. If any are missing, fail fast.
$BRAVE       = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
$WEBSOCKIFY  = "C:\tools\websockify\websockify.exe"   # Standalone Windows build, NOT the Python one
$CLOUDFLARED = "C:\tools\cloudflared\cloudflared.exe"

foreach ($p in @($BRAVE, $WEBSOCKIFY, $CLOUDFLARED)) {
    if (-not (Test-Path $p)) {
        Write-Host "FATAL: missing binary $p — run the one-time install steps in the plan"
        exit 2
    }
}

# Single-flight: only one connect session at a time on this box. Kill any
# leftovers from a previous session that exited uncleanly.
Get-Process brave, websockify, cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 1. Start websockify — translates the noVNC HTML5 client's websocket on
#    :6080 into a raw VNC connection on the local TightVNC server :5900.
$wsArgs = @("--web", "C:\tools\noVNC", "6080", "localhost:5900")
$wsProc = Start-Process -FilePath $WEBSOCKIFY -ArgumentList $wsArgs -PassThru -WindowStyle Hidden
Write-Host "websockify started pid=$($wsProc.Id) on :6080"
Start-Sleep -Seconds 1

# 2. Start cloudflared quick tunnel pointing at :6080. Output goes to a temp
#    file we tail for the public URL.
$tunnelLog = [System.IO.Path]::GetTempFileName()
$cfArgs = @("tunnel", "--no-autoupdate", "--url", "http://localhost:6080")
$cfProc = Start-Process -FilePath $CLOUDFLARED -ArgumentList $cfArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelLog
Write-Host "cloudflared started pid=$($cfProc.Id), waiting for tunnel URL..."

# Tail the log for up to 30s waiting for the URL line. cloudflared prints
# something like: "Your quick tunnel has been created! https://abc.trycloudflare.com"
$tunnelUrl = $null
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and -not $tunnelUrl) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $tunnelLog) {
        $content = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
        if ($content -match "https://[a-z0-9-]+\.trycloudflare\.com") {
            $tunnelUrl = $Matches[0]
        }
    }
}

if (-not $tunnelUrl) {
    Write-Host "FATAL: cloudflared did not print a tunnel URL within 30s"
    Stop-Process -Id $cfProc.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $wsProc.Id -Force -ErrorAction SilentlyContinue
    Remove-Item $tunnelLog -ErrorAction SilentlyContinue
    exit 3
}

# Emit the URL — this is the line social-connect-worker.ts greps for.
# Append /vnc.html for the noVNC client page, plus auto-connect flags.
$noVncUrl = "$tunnelUrl/vnc.html?autoconnect=true&resize=remote"
Write-Host $noVncUrl

# 3. Launch Brave at facebook.com with the operator's persistent profile dir.
$braveArgs = @(
    "--user-data-dir=$ProfileDir"
    "--no-first-run"
    "--no-default-browser-check"
    "--window-size=1280,900"
    "--window-position=0,0"
    "https://www.facebook.com/"
)
$braveProc = Start-Process -FilePath $BRAVE -ArgumentList $braveArgs -PassThru
Write-Host "brave launched pid=$($braveProc.Id) profile=$ProfileDir"

# Block until parent (Node) kills us. We sit in a loop and check that our
# spawned procs are still alive — if Brave exits (operator closed it) we
# also exit so the worker marks the request 'failed' cleanly.
try {
    while ($true) {
        Start-Sleep -Seconds 2
        if ((Get-Process -Id $braveProc.Id -ErrorAction SilentlyContinue) -eq $null) {
            Write-Host "Brave exited; cleaning up"
            break
        }
    }
} finally {
    Stop-Process -Id $braveProc.Id  -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $cfProc.Id     -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $wsProc.Id     -Force -ErrorAction SilentlyContinue
    Remove-Item $tunnelLog -ErrorAction SilentlyContinue
}
```

- [ ] **Step 4.2: Visually verify**

Read the script back. Confirm:
- Three required binaries listed at top with TestPath gate
- Single-flight kill block at the top before launching anything
- cloudflared output tailed via temp file (not stdout — Start-Process can't pipe directly)
- noVNC URL emitted on its own line for the worker to grep
- Cleanup block in `finally` kills all children

- [ ] **Step 4.3: Commit**

```bash
git add scripts/ec2-windows-spawn-noVNC.ps1
git commit -m "feat(scripts): PowerShell spawner for noVNC + cloudflared + Brave"
```

---

## Task 5: Frontend modal (M5)

**Files:**
- Modify: `frontend/src/views/SocialAccounts.tsx`

Replace the SSE-driven Connect flow with: POST to /connect, then poll /connect-status every 2s, then `window.open` the tunnel URL in a new tab, then keep polling until captured/expired/failed.

- [ ] **Step 5.1: Read current Connect handler**

Run: `grep -n "driveLoginFlow\|onConnect" frontend/src/views/SocialAccounts.tsx | head -10`
Open the file and locate the `driveLoginFlow` function (around line 100). This is the SSE stream handler we're replacing.

- [ ] **Step 5.2: Replace driveLoginFlow with polling version**

Find the existing `driveLoginFlow` function and the `ConnectStream` interface that backs it. Replace both with:

```typescript
// ── connect (DB-row poll) ────────────────────────────────────────────
// The Connect button now writes a request row to the DB and the Windows
// EC2 worker fulfills it asynchronously. We poll /connect-status every
// 2s for the tunnel URL, open it in a new tab when ready, and close the
// modal when the worker captures the FB session cookie.
interface ConnectStream {
  status: 'idle' | 'requesting' | 'provisioning' | 'ready' | 'captured' | 'failed' | 'expired';
  tunnelUrl: string | null;
  error?: string;
  // Whether we've already opened the tab — guards against the polling
  // loop re-opening it every tick once the URL appears.
  tabOpened: boolean;
}

async function pollConnectStatus(accountId: string): Promise<{
  connect_status: string | null;
  connect_tunnel_url: string | null;
  connect_error: string | null;
}> {
  const res = await api.get(`/social-accounts/${accountId}/connect-status`);
  return res.data.data;
}

const driveConnect = useCallback(async (accountId: string) => {
  setStreams((prev) => ({
    ...prev,
    [accountId]: { status: 'requesting', tunnelUrl: null, tabOpened: false },
  }));

  try {
    await api.post(`/social-accounts/${accountId}/connect`);
  } catch (err) {
    const msg = (err as { response?: { data?: { error?: string } }; message?: string })
      .response?.data?.error ?? (err as Error).message ?? 'Failed to start connect flow';
    setStreams((prev) => ({
      ...prev,
      [accountId]: { status: 'failed', tunnelUrl: null, tabOpened: false, error: msg },
    }));
    return;
  }

  // Poll every 2s until terminal status. Cancel on unmount via the stream's
  // status — when the modal closes (Set to idle) the loop self-terminates.
  const pollInterval = setInterval(async () => {
    try {
      const view = await pollConnectStatus(accountId);
      setStreams((prev) => {
        const cur = prev[accountId];
        if (!cur || cur.status === 'idle') {
          clearInterval(pollInterval);
          return prev;
        }
        const next: ConnectStream = { ...cur };
        const s = view.connect_status ?? 'requested';
        if (s === 'requested') next.status = 'requesting';
        else if (s === 'provisioning') next.status = 'provisioning';
        else if (s === 'ready') next.status = 'ready';
        else if (s === 'captured') next.status = 'captured';
        else if (s === 'failed') { next.status = 'failed'; next.error = view.connect_error ?? 'unknown'; }
        else if (s === 'expired') { next.status = 'expired'; next.error = 'login window expired (10 min)'; }

        if (view.connect_tunnel_url && !cur.tabOpened) {
          next.tunnelUrl = view.connect_tunnel_url;
          next.tabOpened = true;
          window.open(view.connect_tunnel_url, '_blank', 'noopener,noreferrer');
        }

        if (next.status === 'captured' || next.status === 'failed' || next.status === 'expired') {
          clearInterval(pollInterval);
          if (next.status === 'captured') {
            // Refresh the accounts list so the new active status shows.
            void load();
          }
        }
        return { ...prev, [accountId]: next };
      });
    } catch (err) {
      setStreams((prev) => ({
        ...prev,
        [accountId]: {
          ...prev[accountId],
          status: 'failed',
          error: (err as Error).message,
        },
      }));
      clearInterval(pollInterval);
    }
  }, 2_000);
}, [load]);
```

Then find every place that called `driveLoginFlow(id, 'connect', ...)` and replace with `driveConnect(id)`. The `/recover` flow still uses the old `driveLoginFlow` so keep that function name for recovery — or rename the recovery-only variant.

- [ ] **Step 5.3: Add a modal/status display**

Find the account card render section. After the existing "Connect" button, add the status display that surfaces the connect stream. The user said in the spec: "modal shows 'complete login in the new tab. Captured cookies will close this modal.'"

Within each account's rendered card, after the Connect button block, add:

```tsx
{stream && stream.status !== 'idle' && (
  <div className="mt-3 rounded-lg border border-[#b0004a]/20 bg-[#ffd9de]/30 p-3 text-xs space-y-1">
    {stream.status === 'requesting' && (
      <p className="font-semibold text-[#b0004a]">Requesting a remote browser…</p>
    )}
    {stream.status === 'provisioning' && (
      <p className="font-semibold text-[#b0004a]">Provisioning your remote browser on the worker (~15s)…</p>
    )}
    {stream.status === 'ready' && (
      <>
        <p className="font-semibold text-[#b0004a]">Browser opened in a new tab.</p>
        <p className="text-slate-600">Log into Facebook in the new tab. This window will update automatically once your cookies are captured.</p>
        {stream.tunnelUrl && (
          <a href={stream.tunnelUrl} target="_blank" rel="noopener noreferrer" className="text-[#b0004a] underline">
            Re-open tab
          </a>
        )}
      </>
    )}
    {stream.status === 'captured' && (
      <p className="font-semibold text-emerald-700">✓ Cookies captured — account is active.</p>
    )}
    {(stream.status === 'failed' || stream.status === 'expired') && (
      <>
        <p className="font-semibold text-red-700">{stream.error ?? 'Connect failed.'}</p>
        <button onClick={() => driveConnect(account.id)} className="text-[#b0004a] underline">
          Try again
        </button>
      </>
    )}
  </div>
)}
```

- [ ] **Step 5.4: Type-check frontend**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5.5: Smoke test against running API (local)**

Start the local API: `cd server && npm run dev`
Start the frontend dev server: `cd frontend && npm run dev`
Open http://localhost:5173/social-accounts. Click Connect on any account. The modal should show "Requesting a remote browser…" then "Provisioning…" (and stay there forever since no worker is running locally). This proves the polling loop is wired correctly even when the worker side is absent.

- [ ] **Step 5.6: Commit**

```bash
git add frontend/src/views/SocialAccounts.tsx
git commit -m "feat(social): Connect FB modal polls /connect-status + opens tunnel tab"
```

---

## Task 6: Push + deploy

- [ ] **Step 6.1: Push all M3-M5 commits**

```bash
git push origin main
```

- [ ] **Step 6.2: Deploy Cloud Run (Task 2 ships to the API gateway)**

Run:
```powershell
powershell -ExecutionPolicy Bypass -Command "gcloud run deploy trustpilot-crm --source . --region us-central1 --project=trustpilot-leadgen --quiet"
```

- [ ] **Step 6.3: Verify EC2 auto-pull picked up the new worker**

The Windows EC2 has a scheduled task pulling git every minute (installed earlier today). Wait ~90s, then in an SSM Session Manager terminal on the EC2:

```powershell
cd C:\scraper
git log --oneline -3
```

Expected: top commit matches the last M3-M5 commit we just pushed.

---

## Operator manual step: one-time EC2 install

After all code is shipped, the operator does this ONCE on the Windows EC2 (via SSM Session Manager). The worker won't actually fulfill requests until these are installed.

Open SSM Session Manager to `fb-scraper-windows` and run:

```powershell
# 1. Install TightVNC server (free for non-commercial). VNC listens on :5900.
choco install tightvnc -y --params "/SERVER /SILENT /SET_USEVNCAUTHENTICATION=1 /VALUE_OF_USEVNCAUTHENTICATION=1 /SET_PASSWORD=1 /VALUE_OF_PASSWORD=optirate2026"
# (Password is required for VNC but only the worker connects via localhost — pick anything.)

# 2. Install noVNC HTML5 client + websockify
New-Item -ItemType Directory -Force -Path C:\tools\noVNC, C:\tools\websockify, C:\tools\cloudflared | Out-Null
Invoke-WebRequest -Uri "https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.zip" -OutFile $env:TEMP\novnc.zip
Expand-Archive -Path $env:TEMP\novnc.zip -DestinationPath C:\tools\noVNC -Force
Move-Item C:\tools\noVNC\noVNC-1.4.0\* C:\tools\noVNC\ -Force
# vnc.html is the entry point — verify it exists
Test-Path C:\tools\noVNC\vnc.html

# 3. Install websockify-windows binary (pre-built Go version)
Invoke-WebRequest -Uri "https://github.com/suchja/websockify-windows/releases/download/0.1.0/websockify-windows-amd64.exe" -OutFile C:\tools\websockify\websockify.exe
Test-Path C:\tools\websockify\websockify.exe

# 4. Install cloudflared
Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile C:\tools\cloudflared\cloudflared.exe
& C:\tools\cloudflared\cloudflared.exe --version

# 5. Set the encryption key on the worker (must match what Cloud Run uses)
[Environment]::SetEnvironmentVariable("CRM_ACCOUNT_ENCRYPTION_KEY", "<paste-64-char-hex-from-Cloud-Run-env>", "Machine")

# 6. Enable the worker
[Environment]::SetEnvironmentVariable("ENABLE_SOCIAL_CONNECT_WORKER", "1", "Machine")

# 7. Restart the scraper-worker service so it picks up the new env + new code
nssm restart scraper-worker
Get-Service scraper-worker
```

The operator then triggers Connect Facebook from the dashboard end-to-end — see Verification below.

---

## Verification (end-to-end)

1. From a fresh browser (incognito, never RDP'd into EC2), log into the dashboard.
2. Go to Social Accounts → click Connect Facebook on an existing account row (e.g. `james@optiratesolutions.net`).
3. Modal shows "Requesting…" → "Provisioning…" → "Browser opened in a new tab" (within ~20s).
4. Switch to the new tab — you see the noVNC viewer showing the Windows desktop with Brave open on facebook.com.
5. Click into the noVNC frame and log into FB normally (Enter credentials, complete 2FA / captcha if shown).
6. Within ~5s of successful login, the dashboard modal switches to "✓ Cookies captured — account is active."
7. The noVNC tab closes itself (or you close it manually).
8. Trigger a fresh FB scrape from the dashboard. It uses the freshly-captured cookies.
9. `pytest tests/scraper/ -v` still passes (27/27 from yesterday's M1).

---

## Self-Review

**Spec coverage:**
- ✓ Architecture diagram (spec) — DB-as-message-bus + 3 hosts pattern is implemented by T1 (helpers), T2 (Cloud Run route), T3 (EC2 worker).
- ✓ DB schema (spec M2) — already applied as migration 044; helpers in T1 use exact column names.
- ✓ Cloud Run API change (spec M3 morning) — T2 implements both endpoints.
- ✓ EC2 worker new poll loop (spec M4 morning) — T3 + T4.
- ✓ Frontend modal flow (spec M5 morning) — T5.
- ✓ Verification (spec) — verification section above mirrors the spec's 6-step end-to-end test.
- ✓ Security mitigation (spec): tunnel URL only returned via authenticated GET, 10-min TTL via `connect_expires_at`, tunnel + Brave killed on capture or expiry. All implemented in T3.
- ✓ One operator at a time (spec): T4's PowerShell starts with a `Get-Process brave, websockify, cloudflared | Stop-Process` block, guaranteeing single-flight on the EC2.
- ✓ Out-of-scope items (spec): IG, concurrent sessions, checkpoint recovery via this flow — none of these tasks touch them.

**Placeholder scan:** zero TBDs / TODOs / "add appropriate handling". Every step has concrete code.

**Type consistency:**
- `ConnectStatus` type used in T1 matches the strings used in T2 (`'requested'`), T3 (`'provisioning' / 'ready' / 'captured' / 'expired' / 'failed'`), and T5 frontend (same six strings).
- `connect_session_id`, `connect_tunnel_url`, `connect_expires_at`, `connect_error` column names match across all tasks and the migration 044.
- `encryptCookie` signature matches `server/src/lib/encryption.ts` (`(plaintext: string) => string`).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-04-connect-fb-flow-m3-m5.md`. Two execution options:

**1. Subagent-Driven (recommended for big multi-task plans)** — fresh subagent per task, review between tasks.

**2. Inline Execution** — execute tasks in this session using executing-plans.

Given the size of this plan (5 tasks, ~3 hours of code), Inline Execution is fine but you'll want to checkpoint after each task. Tasks 1, 2, 3, 5 are pure code-and-test. Task 4 (PowerShell) you visually review. Task 6 (push + deploy) is mechanical.

**Which approach?** Default: inline, checkpointing after each commit.

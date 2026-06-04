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

function log(msg: string): void {
  console.log(`[social-connect-worker] ${msg}`);
}

// Module-level re-entrancy guard. While a noVNC session is in flight, pollOnce
// returns immediately so a second concurrent session cannot claim another row
// and fight over EC2 ports.
let busy = false;

/**
 * Kills the entire child-process tree on Windows.
 * `child.kill()` only sends SIGTERM which PowerShell ignores, leaving Brave,
 * cloudflared, and websockify as orphans. `/T /F` forces the whole tree.
 */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
  } catch (err) {
    log(`taskkill failed for pid ${pid}: ${(err as Error).message}`);
  }
}

async function handleRequest(row: ConnectRequestRow): Promise<void> {
  return new Promise((resolve) => {
    log(`claimed account=${row.id} session=${row.connect_session_id}`);
    const profileDir = path.join(PROFILES_ROOT, row.id);

    // Kick off the profile-dir creation and then the rest of the session setup.
    // We intentionally do NOT await fs.mkdir here — the Promise resolves only
    // when the child process terminates (see finishSession below).
    void (async () => {
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
      // finalized tracks whether we have reached a terminal state (captured OR
      // expired). Used by the child exit handler to avoid double-marking a row
      // that was already transitioned by the expiry sweep.
      let finalized = false;
      // sessionEnded ensures finishSession resolves the Promise exactly once
      // regardless of which termination path fires first.
      let sessionEnded = false;

      // Called from every termination path (capture, expiry, child.exit).
      // Idempotent — first caller wins; subsequent calls are no-ops.
      const finishSession = (): void => {
        if (sessionEnded) return;
        sessionEnded = true;
        clearInterval(watchInterval);
        clearInterval(expirySweep);
        resolve();
      };

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
          killProcessTree(child.pid);
          finishSession();
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
          finalized = true; // set before async work so the exit handler sees it
          await updateConnectStatus(row.id, {
            connect_status: 'expired',
            connect_error: 'login not completed within 10 minutes',
          });
          killProcessTree(child.pid);
          finishSession();
        }
      }, 5_000);

      child.on('exit', (code) => {
        if (!finalized) {
          // Browser/script died before we captured cookies. Mark failed unless we
          // already marked expired above.
          log(`script exited code=${code} before capture; marking failed`);
          void updateConnectStatus(row.id, {
            connect_status: 'failed',
            connect_error: `spawn script exited with code ${code}`,
          });
        }
        finishSession();
      });
    })();
  });
}

async function pollOnce(platform: string): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const row = await claimPendingConnectRequest(platform);
    if (!row) return;
    await handleRequest(row);
  } catch (err) {
    log(`poll error: ${(err as Error).message}`);
  } finally {
    busy = false;
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
  process.on('SIGTERM', () => { clearInterval(timer); });
  process.on('SIGINT', () => { clearInterval(timer); });
}

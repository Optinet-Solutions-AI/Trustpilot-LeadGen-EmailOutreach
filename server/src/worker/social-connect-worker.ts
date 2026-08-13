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
import { existsSync } from 'fs';
import path from 'path';
import WebSocket from 'ws';
import {
  ConnectRequestRow,
  claimPendingConnectRequest,
  updateConnectStatus,
  finalizeConnectRequest,
  getConnectStatusValue,
} from '../db/social-connect-requests.js';
import { encryptCookie } from '../lib/encryption.js';
import { getSupabase } from '../lib/supabase.js';
import { chooseBrowseSpawner } from '../services/social-routing.js';
import { config } from '../config.js';

const POLL_INTERVAL_MS = 10_000;
const COOKIE_WATCH_INTERVAL_MS = 2_000;
const END_WATCH_INTERVAL_MS = 3_000;
const PROFILES_ROOT = process.env.FB_PROFILES_ROOT ?? 'C:\\fb-profiles';

/**
 * BROWSE_STREAM controls which spawner is used for browse-mode sessions.
 *   'novnc' (default) — existing full-desktop noVNC path (unchanged)
 *   'cdp'             — lightweight CDP screencast + Node bridge
 * Set BROWSE_STREAM=cdp on the Windows EC2 worker to enable the new path.
 */
const BROWSE_STREAM = (process.env.BROWSE_STREAM ?? 'novnc') as 'novnc' | 'cdp';

// Locate the PowerShell spawn script. The Node process's cwd depends on
// where NSSM/npm started it (typically server/ on Windows EC2, repo root
// on dev machines). The script lives at <repo>/scripts/ regardless. Probe
// both candidates and pick the one that exists.
function resolveScript(scriptName: string): string {
  const candidates = [
    path.resolve(process.cwd(), '..', 'scripts', scriptName),
    path.resolve(process.cwd(), 'scripts', scriptName),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Return the first candidate so spawn fails with a clear "file not found"
  // — better than a silent path-mangling bug.
  return candidates[0];
}

const SPAWN_SCRIPT_NOVNC = resolveScript('ec2-windows-spawn-noVNC.ps1');
const SPAWN_SCRIPT_CDP   = resolveScript('ec2-windows-spawn-cdp.ps1');
const SPAWN_SCRIPT_ADSPOWER_CDP = resolveScript('ec2-windows-spawn-adspower-cdp.ps1');

/** Resolved spawner for the current mode (connect always uses noVNC). */
function resolveSpawnScript(): string { return SPAWN_SCRIPT_NOVNC; }
// Keep the function so any future callers of the old name still compile.
const SPAWN_SCRIPT = resolveSpawnScript();
const FB_SESSION_COOKIE = 'c_user';

// Resolve PYTHON to an absolute path — same reasoning as social-accounts.ts:
// Windows' CreateProcess is finicky about relative .exe paths even with cwd set.
// Used to stop the AdsPower profile ourselves when an adspower-cdp session ends
// (see finishSession below) since the PS spawner's own cleanup only runs on the
// browser-self-close path.
const PYTHON_RAW = config.pythonPath || 'python';
const PYTHON = path.isAbsolute(PYTHON_RAW)
  ? PYTHON_RAW
  : path.resolve(config.projectRoot, PYTHON_RAW);

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

/**
 * Fetches all facebook.com cookies from the running Brave instance via CDP.
 * Returns Selenium-style cookie dicts (name, value, domain, path, secure, httpOnly)
 * that session_store.py can deserialise with json.loads().
 */
async function fetchCookiesViaCDP(): Promise<Record<string, unknown>[]> {
  const versionRes = await fetch('http://localhost:9222/json/version');
  if (!versionRes.ok) throw new Error(`CDP /json/version returned ${versionRes.status}`);
  const versionData = await versionRes.json() as { webSocketDebuggerUrl: string };
  const wsUrl = versionData.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('CDP /json/version did not return a webSocketDebuggerUrl');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP timeout after 5s'));
    }, 5_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          id: number;
          result?: { cookies?: Record<string, unknown>[] };
        };
        if (msg.id === 1) {
          clearTimeout(timer);
          const all = msg.result?.cookies ?? [];
          const fbCookies = all.filter(
            (c) => typeof c['domain'] === 'string' && (c['domain'] as string).includes('facebook.com'),
          );
          ws.close();
          resolve(fbCookies);
        }
      } catch (parseErr) {
        clearTimeout(timer);
        ws.close();
        reject(parseErr);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function handleRequest(row: ConnectRequestRow): Promise<void> {
  const isBrowse = row.connect_mode === 'browse';
  return new Promise((resolve) => {
    log(`claimed account=${row.id} session=${row.connect_session_id} mode=${isBrowse ? 'browse' : 'connect'}`);
    const profileDir = path.join(PROFILES_ROOT, row.id);

    // Kick off the profile-dir creation and then the rest of the session setup.
    // We intentionally do NOT await fs.mkdir here — the Promise resolves only
    // when the child process terminates (see finishSession below).
    void (async () => {
      await fs.mkdir(profileDir, { recursive: true });

      // Set when `kind` is computed below so finishSession (defined further
      // down in this closure, invoked later on every termination path) knows
      // whether this session needs its AdsPower profile stopped.
      let spawnerKind: 'novnc' | 'cdp' | 'adspower-cdp' | null = null;

      // Fleet accounts (bound to an AdsPower profile) get the AdsPower CDP
      // spawner; everything else keeps the legacy noVNC / native-Brave-CDP paths.
      let hasAdspowerProfile = false;
      try {
        const { data } = await getSupabase()
          .from('social_accounts').select('adspower_profile_id').eq('id', row.id).single();
        hasAdspowerProfile = !!(data?.adspower_profile_id);
      } catch (err) {
        log(`adspower_profile_id lookup failed for ${row.id}: ${(err as Error).message}`);
      }
      const kind = chooseBrowseSpawner({ isBrowse, browseStream: BROWSE_STREAM, hasAdspowerProfile });
      spawnerKind = kind;
      const spawnerScript =
        kind === 'adspower-cdp' ? SPAWN_SCRIPT_ADSPOWER_CDP
        : kind === 'cdp' ? SPAWN_SCRIPT_CDP
        : SPAWN_SCRIPT_NOVNC;
      log(`spawner=${kind} script=${spawnerScript}`);

      const spawnArgs: string[] = ['-ExecutionPolicy', 'Bypass', '-File', spawnerScript];
      if (kind === 'adspower-cdp') {
        // AdsPower spawner resolves the profile itself; no -ProfileDir.
        spawnArgs.push('-AccountId', row.id);
        if (row.connect_target_url) spawnArgs.push('-TargetUrl', row.connect_target_url);
      } else if (kind === 'cdp') {
        spawnArgs.push('-ProfileDir', profileDir, '-AccountId', row.id);
        if (row.connect_target_url) spawnArgs.push('-TargetUrl', row.connect_target_url);
      } else {
        spawnArgs.push('-ProfileDir', profileDir, '-AccountId', row.id,
                       '-Mode', isBrowse ? 'browse' : 'connect');
        if (isBrowse && row.connect_target_url) spawnArgs.push('-TargetUrl', row.connect_target_url);
      }

      // Spawn the PowerShell script which prints the tunnel URL to stdout on its
      // first non-blank line, then keeps running to host the noVNC + Brave session.
      const child = spawn('powershell', spawnArgs, { windowsHide: true });

      let tunnelUrl: string | null = null;
      // finalized tracks whether we have reached a terminal state (captured OR
      // expired/ended). Used by the child exit handler to avoid double-marking a
      // row that was already transitioned by the expiry sweep or end-watch.
      let finalized = false;
      // sessionEnded ensures finishSession resolves the Promise exactly once
      // regardless of which termination path fires first.
      let sessionEnded = false;

      // Holds whichever periodic interval is active for this mode:
      //   connect mode → watchInterval (cookie capture)
      //   browse mode  → endWatchInterval (polls for 'ended' status)
      // Both are nullable so finishSession can safely clear either.
      let watchInterval: ReturnType<typeof setInterval> | null = null;
      let endWatchInterval: ReturnType<typeof setInterval> | null = null;

      // Called from every termination path (capture, expiry, end, child.exit).
      // Idempotent — first caller wins; subsequent calls are no-ops.
      const finishSession = (): void => {
        if (sessionEnded) return;
        sessionEnded = true;
        if (watchInterval !== null) clearInterval(watchInterval);
        if (endWatchInterval !== null) clearInterval(endWatchInterval);
        clearInterval(expirySweep);
        if (spawnerKind === 'adspower-cdp') {
          // AdsPower profiles are launched out-of-tree by the AdsPower desktop
          // client (a child of AdsPower.exe, not of our PowerShell), so
          // killProcessTree's taskkill /T /F on `child.pid` never reaches the
          // browser. The PS spawner's own `--stop` cleanup only runs from its
          // `finally` block, which only fires on the browser-self-close path
          // (CDP port stops answering) — the operator-End and expiry paths
          // never reach it. Stop the profile ourselves here, in the one place
          // that runs on every termination path, so it never leaks open.
          try {
            const stopChild = spawn(
              PYTHON,
              ['-m', 'tools.scraper.fleet_session', '--account', row.id, '--stop'],
              { cwd: config.projectRoot, windowsHide: true },
            );
            // CRITICAL: spawn reports a missing executable (ENOENT) via an async
            // 'error' event, NOT a synchronous throw the try/catch would catch.
            // Without this listener an unhandled 'error' crashes the whole worker
            // process, so a stray PYTHON path would take down every session — not
            // just leak this one profile. Same pattern as social-accounts.ts.
            stopChild.on('error', (err) => {
              log(`adspower --stop spawn failed for account=${row.id}: ${err.message}`);
            });
          } catch (err) {
            log(`adspower --stop spawn failed for account=${row.id}: ${(err as Error).message}`);
          }
        }
        resolve();
      };

      // Rolling buffer of recent stdout+stderr lines. On non-zero exit we
      // surface the tail in connect_error so the operator can diagnose
      // PowerShell failures from the API without RDP'ing into the EC2.
      const recentOutput: string[] = [];
      const MAX_RECENT = 40;
      const pushRecent = (tag: string, line: string): void => {
        recentOutput.push(`${tag} ${line}`);
        if (recentOutput.length > MAX_RECENT) recentOutput.shift();
      };

      child.stdout.on('data', async (buf: Buffer) => {
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          log(`[ps stdout] ${trimmed.slice(0, 200)}`);
          pushRecent('out:', trimmed.slice(0, 200));
          // First trycloudflare.com URL we see is the public tunnel.
          // Capture the full path (e.g. /vnc.html?autoconnect=true&resize=remote)
          // so the frontend can open noVNC directly instead of the landing page.
          if (!tunnelUrl) {
            const match = trimmed.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com[^\s]*/i);
            if (match) {
              tunnelUrl = match[0];
              // browse: session is now live — mark 'active'. connect: mark 'ready' (unchanged).
              const statusOnTunnel = isBrowse ? 'active' : 'ready';
              await updateConnectStatus(row.id, {
                connect_status: statusOnTunnel,
                connect_tunnel_url: tunnelUrl,
              });
              log(`tunnel ready (${statusOnTunnel}): ${tunnelUrl}`);
            }
          }
        }
      });

      child.stderr.on('data', (buf: Buffer) => {
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          log(`[ps stderr] ${trimmed.slice(0, 200)}`);
          pushRecent('err:', trimmed.slice(0, 200));
        }
      });

      if (!isBrowse) {
        // CONNECT MODE: Watch Brave's Cookies SQLite for the c_user marker. The
        // cookies live at <profileDir>\Default\Network\Cookies — a SQLite file.
        // Polling its binary content for the FB_SESSION_COOKIE string acts as a
        // cheap trigger; the actual cookie extraction goes through CDP so we get
        // structured JSON that session_store.py can deserialise with json.loads()
        // instead of raw SQLite.
        const cookiesPath = path.join(profileDir, 'Default', 'Network', 'Cookies');
        watchInterval = setInterval(async () => {
          if (finalized) return;
          try {
            const stat = await fs.stat(cookiesPath);
            if (!stat.isFile()) return;
            // Cheap trigger: the SQLite file stores cookie names as plaintext,
            // so we can detect c_user without parsing the binary format.
            const buf = await fs.readFile(cookiesPath);
            if (!buf.includes(FB_SESSION_COOKIE)) return;
            // c_user is present — extract structured cookies via CDP so the Python
            // scraper receives a JSON array it can json.loads() directly.
            try {
              const fbCookies = await fetchCookiesViaCDP();
              if (fbCookies.length === 0) {
                log('CDP returned 0 facebook.com cookies — will retry next tick');
                return;
              }
              const encrypted = encryptCookie(JSON.stringify(fbCookies));
              await finalizeConnectRequest(row.id, encrypted);
              finalized = true;
              log(`captured ${fbCookies.length} cookies for account=${row.id}, killing browser`);
              killProcessTree(child.pid);
              finishSession();
            } catch (cdpErr) {
              log(`CDP cookie fetch failed (will retry next tick): ${(cdpErr as Error).message}`);
            }
          } catch (err) {
            // Cookies file may not exist yet — that's fine, will appear once Brave starts.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              log(`cookies watch error: ${(err as Error).message}`);
            }
          }
        }, COOKIE_WATCH_INTERVAL_MS);
      } else {
        // BROWSE MODE: Poll the DB for 'ended' status set by endBrowseSession()
        // (triggered when the operator clicks End in the frontend). When detected,
        // kill the process tree and finish — do NOT write status (already 'ended').
        endWatchInterval = setInterval(async () => {
          if (finalized) return;
          try {
            const status = await getConnectStatusValue(row.id);
            if (status === 'ended') {
              finalized = true;
              log(`account=${row.id} browse session ended by operator; killing browser`);
              killProcessTree(child.pid);
              finishSession();
            }
          } catch (err) {
            log(`end-watch poll error: ${(err as Error).message}`);
          }
        }, END_WATCH_INTERVAL_MS);
      }

      // Expiry sweep — if we hit connect_expires_at without finishing, give up.
      // connect: marks 'expired'. browse: marks 'ended' (session is over either way).
      const expiresAt = row.connect_expires_at ? new Date(row.connect_expires_at).getTime() : Date.now() + 600_000;
      const expirySweep = setInterval(async () => {
        if (finalized) return;
        if (Date.now() > expiresAt) {
          finalized = true; // set before async work so the exit handler sees it
          if (isBrowse) {
            log(`account=${row.id} browse session expired; marking ended`);
            await updateConnectStatus(row.id, { connect_status: 'ended' });
          } else {
            log(`account=${row.id} expired without capture`);
            await updateConnectStatus(row.id, {
              connect_status: 'expired',
              connect_error: 'login not completed within 10 minutes',
            });
          }
          killProcessTree(child.pid);
          finishSession();
        }
      }, 5_000);

      child.on('exit', (code) => {
        if (!finalized) {
          if (isBrowse) {
            // Browse: operator closed the browser tab / killed Brave manually.
            // Treat as a clean end rather than a failure.
            log(`script exited code=${code} (browse); marking ended`);
            void updateConnectStatus(row.id, { connect_status: 'ended' });
          } else {
            // Connect: browser/script died before we captured cookies. Mark failed
            // unless we already marked expired above. Surface the tail of
            // stdout+stderr in connect_error so the operator can diagnose
            // PowerShell failures from the API without needing to RDP/SSM into EC2.
            const tail = recentOutput.slice(-20).join(' | ');
            const errMsg = `spawn exit=${code} | recent: ${tail}`.slice(0, 1800);
            log(`script exited code=${code} before capture; marking failed`);
            void updateConnectStatus(row.id, {
              connect_status: 'failed',
              connect_error: errMsg,
            });
          }
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

/**
 * On worker startup, any row still in `provisioning` whose `connect_expires_at`
 * has already passed is a ghost from a previous crash — flip it to `failed` so
 * the operator can retry without manual DB intervention.
 * Rows whose expiry is still in the future are an actively-running session
 * (unlikely if the process just started, but safe to leave alone).
 */
async function sweepStuckProvisioning(): Promise<void> {
  const { error } = await getSupabase()
    .from('social_accounts')
    .update({
      connect_status: 'failed',
      connect_error: 'worker restarted mid-session',
    })
    .eq('platform', 'facebook')
    .eq('connect_status', 'provisioning')
    .lt('connect_expires_at', new Date().toISOString());
  if (error) {
    log(`startup sweep error: ${error.message}`);
  } else {
    log('startup sweep complete (any stuck provisioning rows marked failed)');
  }
}

export function startSocialConnectWorker(): void {
  if (process.env.ENABLE_SOCIAL_CONNECT_WORKER !== '1') {
    log('disabled (set ENABLE_SOCIAL_CONNECT_WORKER=1 to enable)');
    return;
  }
  log(`starting; polling every ${POLL_INTERVAL_MS}ms`);
  // Sweep any provisioning rows that survived a previous crash before we enter
  // the poll loop.
  void sweepStuckProvisioning();
  const timer = setInterval(() => { void pollOnce('facebook'); }, POLL_INTERVAL_MS);
  // First tick immediately.
  void pollOnce('facebook');
  process.on('SIGTERM', () => { clearInterval(timer); });
  process.on('SIGINT', () => { clearInterval(timer); });
}

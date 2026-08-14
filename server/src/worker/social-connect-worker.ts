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
import { buildOnboardSteps, OnboardDeps } from './onboard-branch.js';

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

// ---------------------------------------------------------------------------
// Onboarding branch (`connect_mode='onboard'`): create a brand-new AdsPower
// profile for a country that has none yet, then stream it — mirroring the
// existing browse-mode adspower-cdp spawn/tunnel-parse mechanism rather than
// inventing a new one. Activation (status='active', connect_status='captured')
// happens in the API route once the VA finishes the FB login in the streamed
// browser — this branch only gets the row to connect_status='ready', and then
// HOLDS the session open (see handleOnboardRequest) until a terminal status.
// ---------------------------------------------------------------------------

/**
 * Which `connect_status` values end an onboarding stream. Exported and unit
 * tested in isolation because the surrounding hold/teardown logic in
 * `handleOnboardRequest` is only reachable through `pollOnce`'s
 * spawn/DB/timer glue, which has no unit harness (live-smoke territory) —
 * this is the one piece of that decision that can be pulled out and verified
 * directly. `'captured'` is the VA-clicked-Done path (API route); `'expired'`
 * is this branch's own TTL sweep; `'ended'` is watched for parity with
 * browse mode even though nothing currently sets it on an onboard row.
 */
export function isTerminalOnboardStatus(status: string | null | undefined): boolean {
  return status === 'captured' || status === 'expired' || status === 'ended';
}

/**
 * Builds a country-pinned Enigma sticky-session proxy_config JSON string for
 * a freshly created AdsPower profile. Mirrors the sticky-password scheme in
 * tools/scraper/provision_adspower_profile.py (`_sticky_proxy_password`) —
 * same RESIDENTIAL_PROXY_* credentials already used for the FB engagement
 * fleet (no new proxy provider, no new env vars), keyed to a fresh
 * per-onboarding session id so concurrent onboards don't collide on one
 * sticky IP. Falls back to '{}' (adspower.py's own no-proxy default) with a
 * log warning if the residential-proxy env vars aren't configured, rather
 * than failing the whole onboard.
 */
function buildOnboardProxyConfig(country: string, sessionSeed: string): string {
  const host = process.env.RESIDENTIAL_PROXY_HOST;
  const port = process.env.RESIDENTIAL_PROXY_PORT;
  const user = process.env.RESIDENTIAL_PROXY_USERNAME;
  const basePassword = process.env.RESIDENTIAL_PROXY_PASSWORD;
  if (!host || !port || !user || !basePassword) {
    log('RESIDENTIAL_PROXY_* not fully configured — onboarding profile will get no proxy (no_proxy fallback)');
    return '{}';
  }
  const base = basePassword.split('_country-')[0].split('_session-')[0].trim();
  const sessionId = sessionSeed.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'onboard';
  const password = `${base}_country-${country.toUpperCase()}_session-${sessionId}_lifetime-30`;
  return JSON.stringify({
    proxy_soft: 'other',
    proxy_type: 'http',
    proxy_host: host,
    proxy_port: port,
    proxy_user: user,
    proxy_password: password,
  });
}

/** Spawns `python -m tools.scraper.fleet_session --create ...` and resolves
 * the trimmed stdout as the new profile id. */
const onboardCreateProfile: OnboardDeps['createProfile'] = (country, proxyJson) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(
      PYTHON,
      ['-m', 'tools.scraper.fleet_session', '--create', '--country', country, '--proxy-json', proxyJson],
      { cwd: config.projectRoot, windowsHide: true },
    );
    let out = '';
    let errOut = '';
    child.stdout.on('data', (buf: Buffer) => { out += buf.toString('utf8'); });
    child.stderr.on('data', (buf: Buffer) => { errOut += buf.toString('utf8'); });
    // CRITICAL: spawn reports a missing executable (ENOENT) via an async
    // 'error' event, NOT a synchronous throw — same pattern as finishSession's
    // --stop spawn above. Without this listener an unhandled 'error' crashes
    // the whole worker process, not just this one onboard attempt.
    child.on('error', (err) => {
      reject(new Error(`fleet_session --create spawn failed: ${err.message}`));
    });
    child.on('exit', (code) => {
      const profileId = out.trim().split(/\r?\n/).pop()?.trim() ?? '';
      if (code === 0 && profileId) {
        resolve(profileId);
      } else {
        reject(new Error(`fleet_session --create exited code=${code}: ${(errOut || out).slice(-500)}`));
      }
    });
  });

const onboardRecordProfileId: OnboardDeps['recordProfileId'] = async (accountId, profileId) => {
  const { error } = await getSupabase()
    .from('social_accounts')
    .update({ adspower_profile_id: profileId })
    .eq('id', accountId);
  if (error) throw new Error(`recordProfileId: ${error.message}`);
};

const onboardSetReady: OnboardDeps['setReady'] = async (accountId, tunnelUrl) => {
  await updateConnectStatus(accountId, { connect_status: 'ready', connect_tunnel_url: tunnelUrl });
};

/**
 * Runs the full onboard lifecycle for one claimed row and resolves only when
 * the streamed session actually ends — NEVER at 'ready'. This holds the
 * module-level `busy` guard for the whole session, exactly like browse mode's
 * `handleRequest`, because the onboarding stream shares the same fixed
 * BRIDGE_PORT/cloudflared resources as every other adspower-cdp session on
 * this box: releasing `busy` at 'ready' would let a second poll spawn a
 * competing session that tears down this one's tunnel mid-login (the ps1
 * script unconditionally kills anything already on BRIDGE_PORT and every
 * cloudflared process on startup).
 *
 * Reuses browse mode's exact lifecycle pieces: `killProcessTree`,
 * `END_WATCH_INTERVAL_MS`, and a `finishSession`-shaped idempotent teardown
 * (here `finishOnboardSession`). The only new terminal signal is
 * `connect_status='captured'` (set by the API's onboard-complete route once
 * the VA clicks Done) — `'expired'` (this branch's own TTL sweep, mirroring
 * connect mode) and `'ended'` are watched too for parity/future-proofing,
 * plus the stream child exiting on its own.
 */
async function handleOnboardRequest(row: ConnectRequestRow): Promise<void> {
  return new Promise((resolve) => {
    log(`claimed account=${row.id} session=${row.connect_session_id} mode=onboard`);

    void (async () => {
      // finalized: a terminal connect_status has been observed/written — set
      // before any further teardown decision so concurrent timers don't race
      // to write conflicting statuses (same guard shape as handleRequest).
      let finalized = false;
      // sessionEnded: finishOnboardSession has run — idempotent, first caller wins.
      let sessionEnded = false;
      let streamChild: ReturnType<typeof spawn> | null = null;
      let profileIdForStop: string | null = null;
      let endWatchInterval: ReturnType<typeof setInterval> | null = null;
      let expirySweep: ReturnType<typeof setInterval> | null = null;

      // Rolling stdout/stderr tail, same shape as handleRequest's recentOutput,
      // surfaced in connect_error if the stream dies unexpectedly.
      const recentOutput: string[] = [];
      const MAX_RECENT = 40;
      const pushRecent = (tag: string, line: string): void => {
        recentOutput.push(`${tag} ${line}`);
        if (recentOutput.length > MAX_RECENT) recentOutput.shift();
      };

      const finishOnboardSession = (): void => {
        if (sessionEnded) return;
        sessionEnded = true;
        if (endWatchInterval !== null) clearInterval(endWatchInterval);
        if (expirySweep !== null) clearInterval(expirySweep);
        killProcessTree(streamChild?.pid);
        if (profileIdForStop) {
          // Stop by --profile, not --account: the onboarding account's
          // status isn't 'active' yet (activation is the API route's job),
          // and fleet_session's --account resolution requires status='active'
          // — see the -ProfileId addition in the ps1 spawner for the same reason.
          try {
            const stopChild = spawn(
              PYTHON,
              ['-m', 'tools.scraper.fleet_session', '--profile', profileIdForStop, '--stop'],
              { cwd: config.projectRoot, windowsHide: true },
            );
            // CRITICAL: same ENOENT-crashes-the-worker hazard as every other
            // spawn in this file — must have an 'error' listener.
            stopChild.on('error', (err) => {
              log(`onboard adspower --stop spawn failed for account=${row.id}: ${err.message}`);
            });
          } catch (err) {
            log(`onboard adspower --stop spawn failed for account=${row.id}: ${(err as Error).message}`);
          }
        }
        resolve();
      };

      try {
        const { data, error } = await getSupabase()
          .from('social_accounts').select('country').eq('id', row.id).single();
        if (error) throw new Error(`country lookup: ${error.message}`);
        const country = ((data as { country?: string } | null)?.country || '').trim();
        if (!country) throw new Error(`account ${row.id} has no country set`);

        const proxyJson = buildOnboardProxyConfig(country, row.connect_session_id ?? row.id);

        // Reuses SPAWN_SCRIPT_ADSPOWER_CDP — the same spawner + tunnel-URL
        // parsing browse mode uses (`-ProfileId` instead of `-AccountId`, per
        // the reason above). Unlike the pre-fix version, this does NOT settle
        // once the tunnel URL is captured — the child and its exit are wired
        // into the outer closure (`streamChild`, `profileIdForStop`) so the
        // session can be watched and torn down after buildOnboardSteps returns.
        const spawnStream: OnboardDeps['spawnStream'] = (accountId, profileId) =>
          new Promise<string>((resolveStream, rejectStream) => {
            profileIdForStop = profileId;
            const spawnArgs = ['-ExecutionPolicy', 'Bypass', '-File', SPAWN_SCRIPT_ADSPOWER_CDP, '-ProfileId', profileId];
            const child = spawn('powershell', spawnArgs, { windowsHide: true });
            streamChild = child;
            let settled = false;
            // Same ENOENT-crashes-the-worker hazard as every other spawn here.
            child.on('error', (err) => {
              if (!settled) { settled = true; rejectStream(new Error(`adspower-cdp spawn failed for account=${accountId}: ${err.message}`)); }
            });
            child.stdout.on('data', (buf: Buffer) => {
              const lines = buf.toString('utf8').split(/\r?\n/);
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                log(`[onboard ps stdout] ${trimmed.slice(0, 200)}`);
                pushRecent('out:', trimmed.slice(0, 200));
                if (!settled) {
                  // Same trycloudflare match browse mode uses to detect the tunnel line.
                  const match = trimmed.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com[^\s]*/i);
                  if (match) { settled = true; resolveStream(match[0]); }
                }
              }
            });
            child.stderr.on('data', (buf: Buffer) => {
              const trimmed = buf.toString('utf8').trim();
              if (!trimmed) return;
              log(`[onboard ps stderr] ${trimmed.slice(0, 200)}`);
              pushRecent('err:', trimmed.slice(0, 200));
            });
            child.on('exit', (code) => {
              if (!settled) {
                settled = true;
                rejectStream(new Error(`adspower-cdp spawn exited code=${code} before printing a tunnel URL`));
                return;
              }
              // The tunnel was up (and 'ready' presumably set) and the stream
              // ended on its own — e.g. the ps1 script's own CDP-poll loop
              // noticed the AdsPower browser closed. Mirrors handleRequest's
              // child.on('exit'): if no terminal status was reached yet
              // (VA never clicked Done, TTL hadn't fired), mark failed with
              // the recent output tail so the operator can diagnose it.
              if (!finalized) {
                finalized = true;
                const tail = recentOutput.slice(-20).join(' | ');
                void updateConnectStatus(row.id, {
                  connect_status: 'failed',
                  connect_error: `onboard stream exited code=${code} | recent: ${tail}`.slice(0, 1800),
                });
              }
              finishOnboardSession();
            });
          });

        await buildOnboardSteps(
          { accountId: row.id, country, proxyJson },
          {
            createProfile: onboardCreateProfile,
            recordProfileId: onboardRecordProfileId,
            spawnStream,
            setReady: onboardSetReady,
          },
        );

        // 'ready' is now set and the CDP stream is live. Do NOT resolve here —
        // hold `busy` for the whole session (see the function doc comment).
        // End-watch: poll for the row reaching a terminal connect_status, the
        // same shape as handleRequest's browse-mode end-watch loop.
        endWatchInterval = setInterval(async () => {
          if (finalized) return;
          try {
            const status = await getConnectStatusValue(row.id);
            if (isTerminalOnboardStatus(status)) {
              finalized = true;
              log(`account=${row.id} onboard session reached terminal status=${status}; tearing down stream`);
              finishOnboardSession();
            }
          } catch (err) {
            log(`onboard end-watch poll error: ${(err as Error).message}`);
          }
        }, END_WATCH_INTERVAL_MS);

        // TTL sweep — mirrors connect mode's expirySweep: if the VA abandons
        // the login before the TTL, mark 'expired' ourselves rather than
        // waiting forever for a 'captured' that will never come.
        const expiresAt = row.connect_expires_at ? new Date(row.connect_expires_at).getTime() : Date.now() + 600_000;
        expirySweep = setInterval(async () => {
          if (finalized) return;
          if (Date.now() > expiresAt) {
            finalized = true; // set before async work, mirroring handleRequest's expirySweep
            log(`account=${row.id} onboard session expired without completion; marking expired`);
            try {
              await updateConnectStatus(row.id, {
                connect_status: 'expired',
                connect_error: 'onboarding login not completed within the session TTL',
              });
            } catch (statusErr) {
              // finalized is already true, so every later expirySweep/end-watch
              // tick would short-circuit forever if we let this throw skip
              // teardown below — always fall through to finishOnboardSession()
              // so the stream/profile don't leak and `busy` gets released.
              log(`onboard expiry status update failed for account=${row.id}: ${(statusErr as Error).message}`);
            }
            finishOnboardSession();
          }
        }, 5_000);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        log(`onboard failed for account=${row.id}: ${message}`);
        try {
          await updateConnectStatus(row.id, { connect_status: 'failed', connect_error: message.slice(0, 1800) });
        } catch (statusErr) {
          log(`onboard failed-status update also failed for account=${row.id}: ${(statusErr as Error).message}`);
        }
        finishOnboardSession();
      }
    })();
  });
}

async function pollOnce(platform: string): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const row = await claimPendingConnectRequest(platform);
    if (!row) return;
    if (row.connect_mode === 'onboard') {
      await handleOnboardRequest(row);
    } else {
      await handleRequest(row);
    }
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

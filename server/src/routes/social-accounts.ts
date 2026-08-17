/**
 * Social Accounts route — CRUD for the social_accounts table plus the
 * operator-driven connect / recover flows that spawn
 * tools/scraper/shared/login_flows.py as a child process.
 *
 * The connect flow streams STAGE: events from Python's stdout straight
 * to the frontend over SSE so the UI can show "browser_open ->
 * waiting_for_login -> cookies_captured -> done" in real time.
 */
import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { encryptCookie } from '../lib/encryption.js';
import { enqueueConnectRequest, getConnectRequestStatus, enqueueBrowseSession, endBrowseSession, AccountInUseError, enqueueOnboardRequest, activateOnboardedAccount } from '../db/social-connect-requests.js';
import { listActiveCountries } from '../db/social-accounts-countries.js';

const router = Router();

// Resolve PYTHON to an absolute path. Windows' CreateProcess (which Node's
// spawn calls under the hood) is finicky about relative .exe paths even when
// cwd is set — observed locally that '.venv/Scripts/python.exe' spawns a
// dead process with no output, but the absolute path works fine.
const PROJECT_ROOT = config.projectRoot;
const PYTHON_RAW = config.pythonPath || 'python';
const PYTHON = path.isAbsolute(PYTHON_RAW)
  ? PYTHON_RAW
  : path.resolve(PROJECT_ROOT, PYTHON_RAW);

type Platform = 'facebook' | 'instagram';

// ── GET /api/social-accounts ─────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('social_accounts')
      .select('id,platform,handle,display_name,status,country,proxy_location,daily_cap,hourly_cap,comment_daily_cap,comment_used_today,used_today,used_this_hour,last_login_at,last_used_at,last_checkpoint_at,checkpoint_reason,notes,created_at,updated_at,connect_mode,connect_status,encrypted_cookies,encrypted_fb_username,encrypted_fb_password')
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    // Don't ship any ciphertext over the wire — just boolean signals.
    const masked = (data ?? []).map((row: Record<string, unknown>) => {
      const { encrypted_cookies, encrypted_fb_username, encrypted_fb_password, ...rest } = row;
      return {
        ...rest,
        has_cookies: !!encrypted_cookies,
        has_credentials: !!(encrypted_fb_username && encrypted_fb_password),
      };
    });
    res.json({ success: true, data: masked });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── POST /api/social-accounts ────────────────────────────────────────
// Create the row only — operator must then click "Connect" to do login.
router.post('/', async (req: Request, res: Response) => {
  try {
    const { platform, handle, display_name, country, proxy_location, daily_cap, hourly_cap, comment_daily_cap } = req.body as {
      platform?: Platform; handle?: string; display_name?: string;
      country?: string; proxy_location?: string;
      daily_cap?: number; hourly_cap?: number; comment_daily_cap?: number;
    };
    if (!platform || !['facebook', 'instagram'].includes(platform)) {
      res.status(400).json({ success: false, error: 'platform must be facebook or instagram' });
      return;
    }
    if (!handle || !handle.trim()) {
      res.status(400).json({ success: false, error: 'handle is required' });
      return;
    }
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('social_accounts')
      .insert({
        platform,
        handle: handle.trim(),
        display_name: display_name ?? null,
        status: 'disabled',                // becomes 'active' once cookies land
        country: country ?? null,
        proxy_location: proxy_location ?? null,
        daily_cap: daily_cap ?? (platform === 'instagram' ? 25 : 50),
        hourly_cap: hourly_cap ?? 10,
        comment_daily_cap: comment_daily_cap ?? 3,
        // Start the comment-budget warmup ramp now — a new account posts at a
        // reduced cap for its first ~3 weeks (see effectiveCommentCap).
        warmup_started_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── GET /api/social-accounts/countries ───────────────────────────────
// Distinct active-account countries (drives the FB scrape dropdown,
// Option A). Registered BEFORE any /:id route so 'countries' is never
// parsed as an :id.
router.get('/countries', async (_req: Request, res: Response) => {
  try {
    const countries = await listActiveCountries();
    res.json({ success: true, data: { countries } });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── POST /api/social-accounts/onboard ────────────────────────────────
// Start onboarding a NEW country-pinned FB account (creates the row; the
// EC2 worker does the AdsPower profile creation + stream). Also
// registered before any /:id route for the same reason as /countries.
router.post('/onboard', async (req: Request, res: Response) => {
  const country = String(req.body?.country ?? '').trim();
  if (!country) {
    res.status(400).json({ success: false, error: 'country is required' });
    return;
  }
  try {
    const requestedBy = String(req.body?.requestedBy ?? 'va');
    const labelRaw = req.body?.label;
    const label = typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim() : undefined;
    const { accountId } = await enqueueOnboardRequest({ country, requestedBy, label });
    res.json({ success: true, data: { accountId } });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── PATCH /api/social-accounts/:id ───────────────────────────────────
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const body = req.body as Record<string, unknown>;
    const allowed: Record<string, unknown> = {};
    for (const k of ['daily_cap', 'hourly_cap', 'status', 'notes', 'display_name', 'country', 'proxy_location', 'comment_daily_cap']) {
      if (k in body) allowed[k] = body[k];
    }

    // Credential fields — encrypt before storage; empty string clears (null).
    // These are NOT in the plain allowlist loop above so raw values never slip through.
    if ('fb_username' in body) {
      const raw = typeof body.fb_username === 'string' ? body.fb_username.trim() : '';
      allowed.encrypted_fb_username = raw ? encryptCookie(raw) : null;
    }
    if ('fb_password' in body) {
      const raw = typeof body.fb_password === 'string' ? body.fb_password : '';
      allowed.encrypted_fb_password = raw ? encryptCookie(raw) : null;
    }

    allowed.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('social_accounts')
      .update(allowed)
      .eq('id', req.params.id)
      .select('id,platform,handle,display_name,status,country,proxy_location,daily_cap,hourly_cap,comment_daily_cap,comment_used_today,used_today,used_this_hour,last_login_at,last_used_at,last_checkpoint_at,checkpoint_reason,notes,created_at,updated_at,connect_mode,connect_status,encrypted_cookies,encrypted_fb_username,encrypted_fb_password')
      .single();
    if (error) throw new Error(error.message);
    // Mask ciphertext before returning — same transform as GET /.
    const { encrypted_cookies, encrypted_fb_username, encrypted_fb_password, ...rest } =
      data as Record<string, unknown>;
    const masked = {
      ...rest,
      has_cookies: !!encrypted_cookies,
      has_credentials: !!(encrypted_fb_username && encrypted_fb_password),
    };
    res.json({ success: true, data: masked });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── DELETE /api/social-accounts/:id ──────────────────────────────────
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('social_accounts')
      .delete()
      .eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── Shared connect/recover SSE driver ────────────────────────────────
/**
 * Spawn the Python login_flows subprocess and stream its progress.
 *
 * `creds` are passed via spawn env (NOT command-line args, NOT logged)
 * and the Python child pops them off process.env immediately, so they
 * exist only briefly in the spawn's env block. Nothing is persisted.
 */
function streamLoginFlow(
  accountId: string,
  recover: boolean,
  req: Request,
  res: Response,
  creds?: { username?: string; password?: string },
): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // -u forces unbuffered stdout/stderr at the Python interpreter level.
  // Belt + suspenders with PYTHONUNBUFFERED=1 below: on Windows, pipe
  // stdout from a subprocess is fully-buffered by default, and Python
  // can die before its first print line flushes. Combined with
  // PYTHONIOENCODING for UTF-8 stage names.
  const args = ['-u', '-m', 'tools.scraper.shared.login_flows', '--account-id', accountId];
  if (recover) args.push('--recover');

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  if (creds?.username && creds?.password) {
    childEnv.SOCIAL_LOGIN_USERNAME = creds.username;
    childEnv.SOCIAL_LOGIN_PASSWORD = creds.password;
  }

  console.log(`[social-accounts] PYTHON=${PYTHON} args=${args.slice(0, 5).join(' ')} cwd=${PROJECT_ROOT}`);

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const child = spawn(PYTHON, args, {
    cwd: PROJECT_ROOT,
    env: childEnv,
    shell: false,
    windowsHide: false,
    // Explicit stdio: 'ignore' for stdin (Python doesn't read it),
    // 'pipe' for stdout + stderr. Default 'pipe' for all was leaving
    // stdin open which can cause Python to wait for input on certain
    // initialization paths.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(`[social-accounts] spawned pid=${child.pid}`);
  // CRITICAL: handle the 'error' event. Without this listener, a spawn
  // failure (e.g. python.exe not found) crashes the entire API process
  // with an uncaught EventEmitter error rather than surfacing.
  child.on('error', (err) => {
    console.error('[social-accounts] spawn error:', err.message);
    send('stderr', { line: `spawn error: ${err.message}` });
    send('exit', { code: -1, error: err.message });
    try { res.end(); } catch { /* ignore */ }
  });
  // Also log when child closes (separate from exit) so we can see what
  // Windows reports.
  child.on('close', (code, signal) => {
    console.log(`[social-accounts] pid=${child.pid} close code=${code} signal=${signal}`);
  });
  // Zero our local handle to the password so a heap dump of this process
  // doesn't keep it around. The spawn() call has already copied it into
  // the child's env block at this point.
  if (creds) {
    creds.password = undefined;
    creds.username = undefined;
  }

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const raw = chunk.toString('utf8');
    console.log('[social-accounts] PY STDOUT chunk:', JSON.stringify(raw.slice(0, 200)));
    buffer += raw;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('STAGE:')) {
        const rest = line.slice('STAGE:'.length);
        const [stage, ...detailParts] = rest.split(':');
        send('stage', { stage, detail: detailParts.join(':') || null });
      } else if (line) {
        // Non-STAGE stdout is still useful when something explodes before
        // the harness emits its first event (e.g. missing env key).
        send('stdout', { line });
      }
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8');
    console.log('[social-accounts] PY STDERR:', line.slice(0, 500));
    send('stderr', { line });
  });

  child.on('exit', (code) => {
    send('exit', { code });
    res.end();
  });

  // Kill the child only when the client closes the SSE connection BEFORE
  // we're done. Listen on the RESPONSE, not the request — req 'close'
  // fires when the request body upload ends (immediate for a POST), and
  // would SIGTERM the child within milliseconds of spawning.
  let childExited = false;
  child.on('exit', () => { childExited = true; });
  res.on('close', () => {
    if (childExited) return;
    if (res.writableEnded) return;
    console.log(`[social-accounts] client disconnected, killing pid=${child.pid}`);
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  });
}

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
    if (err instanceof AccountInUseError) {
      res.status(409).json({ success: false, error: `In use by ${err.heldBy ?? 'another user'}${err.expiresAt ? ` until ${err.expiresAt}` : ''}` });
      return;
    }
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

// ── POST /api/social-accounts/:id/onboard-complete ───────────────────
// VA clicked "Done" in the streamed onboarding browser — verify + activate.
router.post('/:id/onboard-complete', async (req: Request, res: Response) => {
  try {
    await activateOnboardedAccount(String(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── POST /api/social-accounts/:id/recover (SSE) ──────────────────────
router.post('/:id/recover', (req: Request, res: Response) => {
  streamLoginFlow(String(req.params.id), true, req, res);
});

// ── POST /api/social-accounts/:id/browse ─────────────────────────────
router.post('/:id/browse', async (req: Request, res: Response) => {
  try {
    const { targetUrl, requestedBy } = req.body as { targetUrl?: string; requestedBy?: string };
    if (!requestedBy) { res.status(400).json({ success: false, error: 'requestedBy is required' }); return; }
    const row = await enqueueBrowseSession(String(req.params.id), { targetUrl: targetUrl ?? null, requestedBy });
    res.json({ success: true, data: row });
  } catch (err) {
    if (err instanceof AccountInUseError) {
      res.status(409).json({ success: false, error: `In use by ${err.heldBy ?? 'another user'}${err.expiresAt ? ` until ${err.expiresAt}` : ''}` });
      return;
    }
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── POST /api/social-accounts/:id/browse/end ─────────────────────────
router.post('/:id/browse/end', async (req: Request, res: Response) => {
  try { await endBrowseSession(String(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: (err as Error).message }); }
});

export default router;

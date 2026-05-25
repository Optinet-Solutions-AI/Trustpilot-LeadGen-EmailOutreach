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

const router = Router();

const PYTHON = config.pythonPath || 'python';
const PROJECT_ROOT = config.projectRoot;

type Platform = 'facebook' | 'instagram';

// ── GET /api/social-accounts ─────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('social_accounts')
      .select('id,platform,handle,display_name,status,daily_cap,hourly_cap,used_today,used_this_hour,last_login_at,last_used_at,last_checkpoint_at,checkpoint_reason,notes,created_at,updated_at,encrypted_cookies')
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    // Don't ship the ciphertext over the wire — just a boolean signal.
    const masked = (data ?? []).map((row: Record<string, unknown>) => {
      const { encrypted_cookies, ...rest } = row;
      return { ...rest, has_cookies: !!encrypted_cookies };
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
    const { platform, handle, display_name, daily_cap, hourly_cap } = req.body as {
      platform?: Platform; handle?: string; display_name?: string;
      daily_cap?: number; hourly_cap?: number;
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
        daily_cap: daily_cap ?? (platform === 'instagram' ? 25 : 50),
        hourly_cap: hourly_cap ?? 10,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── PATCH /api/social-accounts/:id ───────────────────────────────────
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const allowed: Record<string, unknown> = {};
    for (const k of ['daily_cap', 'hourly_cap', 'status', 'notes', 'display_name']) {
      if (k in req.body) allowed[k] = (req.body as Record<string, unknown>)[k];
    }
    allowed.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('social_accounts')
      .update(allowed)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
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
  res: Response,
  creds?: { username?: string; password?: string },
): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const args = ['-m', 'tools.scraper.shared.login_flows', '--account-id', accountId];
  if (recover) args.push('--recover');

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (creds?.username && creds?.password) {
    childEnv.SOCIAL_LOGIN_USERNAME = creds.username;
    childEnv.SOCIAL_LOGIN_PASSWORD = creds.password;
  }

  const child = spawn(PYTHON, args, {
    cwd: PROJECT_ROOT,
    env: childEnv,
  });
  // Zero our local handle to the password so a heap dump of this process
  // doesn't keep it around. The spawn() call has already copied it into
  // the child's env block at this point.
  if (creds) {
    creds.password = undefined;
    creds.username = undefined;
  }

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
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
    send('stderr', { line: chunk.toString('utf8') });
  });

  child.on('exit', (code) => {
    send('exit', { code });
    res.end();
  });

  req_close(req_safe(res), () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  });
}

// Tiny shims to keep TypeScript happy with the Express types.
function req_safe(res: Response): Request {
  return (res as unknown as { req: Request }).req;
}
function req_close(req: Request, fn: () => void): void {
  req.on('close', fn);
}

// ── POST /api/social-accounts/:id/connect (SSE) ──────────────────────
// Body may include { username, password } for autofill — both optional;
// when present, the Python child uses them once to pre-fill the form and
// then discards them.
router.post('/:id/connect', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { username?: string; password?: string };
  streamLoginFlow(String(req.params.id), false, res, {
    username: body.username,
    password: body.password,
  });
});

// ── POST /api/social-accounts/:id/recover (SSE) ──────────────────────
router.post('/:id/recover', (req: Request, res: Response) => {
  streamLoginFlow(String(req.params.id), true, res);
});

export default router;

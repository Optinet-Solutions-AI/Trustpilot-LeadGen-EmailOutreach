/**
 * Comment-drafts routes — /api/comment-drafts
 *
 * Endpoints:
 *   POST   /draft        Generate + persist a comment draft for a lead.
 *   GET    /             List drafts for a lead (?lead_id= required).
 *   PATCH  /:id          Edit draft_text or set status to approved/discarded.
 *   POST   /:id/post     Post an approved draft via the Python Facebook action.
 *
 * Account resolution (resolveLeadAccount):
 *   1. Check lead_platform_presences for platform='facebook' with a social_account_id
 *      that points to an active account — the lead's own capturing account is preferred.
 *   2. Fallback: read leads.country and pick an active facebook social_accounts row
 *      pinned to that country.
 *   3. If neither resolves → return null (caller responds 409).
 *   NEVER falls back to an arbitrary cross-country account.
 *
 * Spawn helper (runPythonJson):
 *   Collects all stdout, JSON-parses the LAST non-empty line only.
 *   Intermediate PROGRESS lines emitted by the CLI are silently skipped.
 *   Rejects on non-zero exit or unparseable output.
 *
 * Counter note (POST /:id/post):
 *   comment_used_today is NOT incremented here after a successful post.
 *   The Python post_comment action already bumps it in the DB via
 *   social_accounts.comment_used_today += 1. Double-counting would burn the
 *   daily cap and trigger false 409s on subsequent posts from the same account.
 */
import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';
import {
  createDraft,
  listDraftsForLead,
  getDraft,
  updateDraft,
  markPosted,
  markFailed,
  type DraftStatus,
} from '../db/comment-drafts.js';

const router = Router();

const PROJECT_ROOT = config.projectRoot;
const PYTHON_RAW = config.pythonPath || 'python';
const PYTHON = path.isAbsolute(PYTHON_RAW)
  ? PYTHON_RAW
  : path.resolve(PROJECT_ROOT, PYTHON_RAW);

// ── Spawn helper ──────────────────────────────────────────────────────────────
/**
 * Spawn run.py with the given args, collect all stdout, and JSON-parse the
 * LAST non-empty line. Progress/log lines emitted before the final JSON line
 * are ignored. Rejects on non-zero exit or unparseable final line.
 */
function runPythonJson(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(PROJECT_ROOT, 'tools', 'scraper', 'run.py');
    const allArgs = ['-u', scriptPath, ...args];

    console.log(`[comment-drafts] PYTHON=${PYTHON} args=${allArgs.join(' ')}`);

    const child = spawn(PYTHON, allArgs, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Surface spawn failures (e.g. python.exe not found) as rejections
    // rather than crashing the process with an uncaught EventEmitter error.
    child.on('error', (err) => {
      reject(new Error(`spawn error: ${err.message}`));
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('exit', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || '(no output)';
        return reject(new Error(`python exited with code ${code}: ${detail.slice(0, 500)}`));
      }
      // Parse the LAST non-empty line — the CLI may emit PROGRESS: prefixed
      // intermediate lines before the final JSON result line.
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        return reject(new Error('python produced no output'));
      }
      try {
        resolve(JSON.parse(lastLine));
      } catch {
        reject(new Error(`unparseable python output: ${lastLine.slice(0, 200)}`));
      }
    });
  });
}

// ── Account resolution ────────────────────────────────────────────────────────
interface ResolvedAccount {
  account_id: string;
  country: string | null;
}

/**
 * Resolve which social account to use for a given lead's Facebook comment.
 *
 * Priority:
 *   1. lead_platform_presences.social_account_id (lead's own capturing account)
 *      — only if that account is currently active.
 *   2. Active facebook social_accounts row pinned to the lead's country.
 *
 * Returns null if no suitable account is found (caller must 409).
 */
async function resolveLeadAccount(lead_id: string): Promise<ResolvedAccount | null> {
  const supabase = getSupabase();

  // 1. Check presence row for the lead's own capturing account
  const { data: presences, error: presenceErr } = await supabase
    .from('lead_platform_presences')
    .select('social_account_id')
    .eq('lead_id', lead_id)
    .eq('platform', 'facebook')
    .not('social_account_id', 'is', null)
    .limit(1);
  if (presenceErr) throw new Error(`resolveLeadAccount presence lookup: ${presenceErr.message}`);

  const presenceSocialId = presences?.[0]?.social_account_id as string | null | undefined;
  if (presenceSocialId) {
    const { data: acct, error: acctErr } = await supabase
      .from('social_accounts')
      .select('id, country, status')
      .eq('id', presenceSocialId)
      .eq('status', 'active')
      .maybeSingle();
    if (acctErr) throw new Error(`resolveLeadAccount account lookup: ${acctErr.message}`);
    if (acct) {
      return { account_id: acct.id as string, country: acct.country as string | null };
    }
    // Account found but not active — fall through to country-based lookup
  }

  // 2. Country-based fallback — find the lead's country, then an active account there
  const { data: leadRow, error: leadErr } = await supabase
    .from('leads')
    .select('country')
    .eq('id', lead_id)
    .maybeSingle();
  if (leadErr) throw new Error(`resolveLeadAccount lead lookup: ${leadErr.message}`);

  const country = (leadRow as { country?: string | null } | null)?.country ?? null;

  const query = supabase
    .from('social_accounts')
    .select('id, country')
    .eq('platform', 'facebook')
    .eq('status', 'active')
    .limit(1);

  // Pin to country only when we know the lead's country — never pick a
  // cross-country account as a catch-all fallback.
  if (country) {
    query.eq('country', country);
  } else {
    // No country on the lead and no capturing account → cannot resolve safely.
    return null;
  }

  const { data: accts, error: acctErr2 } = await query;
  if (acctErr2) throw new Error(`resolveLeadAccount country account lookup: ${acctErr2.message}`);

  const fallback = accts?.[0] as { id: string; country: string | null } | undefined;
  if (!fallback) return null;

  return { account_id: fallback.id, country: fallback.country };
}

// ── POST /api/comment-drafts/draft ───────────────────────────────────────────
router.post('/draft', async (req: Request, res: Response) => {
  try {
    const { lead_id, post_url, post_excerpt, niche } = req.body as {
      lead_id?: string;
      post_url?: string;
      post_excerpt?: string;
      niche?: string;
    };

    if (!lead_id || !post_url || !post_excerpt || !niche) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: lead_id, post_url, post_excerpt, niche',
      });
      return;
    }

    const resolved = await resolveLeadAccount(lead_id);
    if (!resolved) {
      // Fetch country for the error message
      const { data: leadRow } = await getSupabase()
        .from('leads')
        .select('country')
        .eq('id', lead_id)
        .maybeSingle();
      const country = (leadRow as { country?: string | null } | null)?.country ?? 'unknown';
      res.status(409).json({
        success: false,
        error: `No active Facebook account pinned to this lead's country (${country})`,
      });
      return;
    }

    // Spawn the Python draft-comment action
    const result = await runPythonJson([
      '--platform', 'facebook',
      '--action', 'draft-comment',
      '--filters', JSON.stringify({ post_excerpt, niche }),
    ]) as { text?: string | null };

    if (!result.text) {
      res.status(502).json({
        success: false,
        error: 'Comment draft unavailable (no GEMINI key or API error)',
      });
      return;
    }

    const draft = await createDraft({
      lead_id,
      post_url,
      account_id: resolved.account_id,
      draft_text: result.text,
    });

    res.json({ success: true, data: draft });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── GET /api/comment-drafts/ (?lead_id=) ────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const lead_id = req.query.lead_id as string | undefined;
    if (!lead_id) {
      res.status(400).json({ success: false, error: 'lead_id query param is required' });
      return;
    }
    const drafts = await listDraftsForLead(lead_id);
    res.json({ success: true, data: drafts });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── PATCH /api/comment-drafts/:id ────────────────────────────────────────────
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { draft_text, status } = req.body as { draft_text?: string; status?: string };

    if (status !== undefined && !['approved', 'discarded'].includes(status)) {
      res.status(400).json({
        success: false,
        error: `status must be 'approved' or 'discarded' (got '${status}')`,
      });
      return;
    }

    const patch: { draft_text?: string; status?: DraftStatus } = {};
    if (draft_text !== undefined) patch.draft_text = draft_text;
    if (status !== undefined) patch.status = status as DraftStatus;

    const updated = await updateDraft(String(req.params.id), patch);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── POST /api/comment-drafts/:id/post ────────────────────────────────────────
router.post('/:id/post', async (req: Request, res: Response) => {
  try {
    // 1. Load the draft
    const draft = await getDraft(String(req.params.id));
    if (!draft) {
      res.status(404).json({ success: false, error: 'Draft not found' });
      return;
    }

    // 2. Require approved status
    if (draft.status !== 'approved') {
      res.status(400).json({ success: false, error: 'draft must be approved before posting' });
      return;
    }

    // 3. Check daily cap before spawning
    const { data: acctRow, error: acctErr } = await getSupabase()
      .from('social_accounts')
      .select('comment_used_today, comment_daily_cap')
      .eq('id', draft.account_id)
      .maybeSingle();
    if (acctErr) throw new Error(`account cap lookup: ${acctErr.message}`);
    if (!acctRow) {
      res.status(409).json({ success: false, error: 'account not found' });
      return;
    }
    const { comment_used_today, comment_daily_cap } = acctRow as {
      comment_used_today: number;
      comment_daily_cap: number;
    };
    if (comment_used_today >= comment_daily_cap) {
      res.status(409).json({ success: false, error: 'comment cap reached' });
      return;
    }

    // 4. Spawn post-comment
    const result = await runPythonJson([
      '--platform', 'facebook',
      '--action', 'post-comment',
      '--filters', JSON.stringify({
        post_url: draft.post_url,
        text: draft.draft_text,
        account_id: draft.account_id,
      }),
    ]) as { posted?: boolean; error?: string | null };

    if (result.posted === true) {
      // DO NOT increment comment_used_today here — the Python post_comment action
      // already bumps social_accounts.comment_used_today += 1 in the DB.
      // Incrementing it again here would double-count and prematurely exhaust
      // the daily cap, causing valid subsequent posts to be rejected with 409.
      const updated = await markPosted(draft.id);
      res.json({ success: true, data: updated });
    } else {
      const errMsg = result.error || 'post failed';
      await markFailed(draft.id, errMsg);
      res.status(502).json({ success: false, error: errMsg });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;

/**
 * Social Groups route — read + status-update for the fb_group_candidates
 * assisted-join queue, PLUS the Discovered Groups feature added on top of
 * the same table:
 *
 *   /queue        — the assisted-join workflow (Group Queue page): groups
 *                    the account hasn't joined yet, filtered by status.
 *   /discovered   — EVERY group we've ever seen posts from (any status),
 *                    ranked by how many posts we've captured from it. This
 *                    is the "what if I don't have group URLs?" answer:
 *                    groups already arrive as a by-product of every FB post
 *                    scrape (tools/db/upsert_group_candidates.py), this
 *                    just surfaces them.
 *   /label        — on-demand trigger for the Gemini batch labeller
 *                    (tools/scraper/label_fb_groups.py), so the operator
 *                    can label newly-captured groups without a terminal.
 *
 * The scraper (via upsert_leads.py) populates/refreshes rows; this route
 * only reads and does status/label writes.
 */
import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';

const router = Router();

const STATUSES = ['candidate', 'joined', 'ignored'] as const;
type GroupStatus = (typeof STATUSES)[number];

// ── GET /api/social-groups/queue?status=candidate ────────────────────
router.get('/queue', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'candidate';
    if (!STATUSES.includes(status as GroupStatus)) {
      res.status(400).json({ success: false, error: `status must be one of ${STATUSES.join(', ')}` });
      return;
    }
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('fb_group_candidates')
      .select('id,platform,group_id,name,member_count_text,is_private,relevance_tier,niche,location,status,first_seen_at,last_seen_at,joined_detected_at')
      .eq('platform', 'facebook')
      .eq('status', status)
      .order('relevance_tier', { ascending: false })
      .order('last_seen_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ success: true, data: data ?? [] });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── PATCH /api/social-groups/queue/:id  body { status } ──────────────
router.patch('/queue/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body as { status?: string };
    if (!status || !STATUSES.includes(status as GroupStatus)) {
      res.status(400).json({ success: false, error: `status must be one of ${STATUSES.join(', ')}` });
      return;
    }
    const supabase = getSupabase();
    const patch: Record<string, unknown> = { status };
    if (status === 'joined') patch.joined_detected_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('fb_group_candidates')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── GET /api/social-groups/discovered ─────────────────────────────────
//
// Every fb_group_candidates row (any status — unlike /queue, which is
// scoped to the assisted-join workflow), enriched with how many posts
// we've captured from each group and when we last saw one, sorted so the
// most productive groups surface first. Powers the Discovered Groups page.
//
// post_count/last_post_seen are computed here rather than stored on the
// row: lead_platform_posts is the single source of truth for "how many
// posts have we seen", and the two write paths that touch
// fb_group_candidates (upsert_group_candidates.py and the labelling job)
// deliberately never touch a counter, so there is nothing to drift.
router.get('/discovered', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();

    const { data: groupRows, error: groupErr } = await supabase
      .from('fb_group_candidates')
      .select('id,platform,group_id,name,member_count_text,is_private,relevance_tier,niche,location,audience,status,first_seen_at,last_seen_at,joined_detected_at')
      .eq('platform', 'facebook');
    if (groupErr) throw new Error(groupErr.message);

    // Paginate past PostgREST's default 1000-row cap — today's post count
    // (~230) is well under it, but this only grows. Same defensive pattern
    // as tools/scraper/backfill_fb_groups.py's _collect_groups.
    const postCounts = new Map<string, { count: number; lastSeen: string | null }>();
    const PAGE_SIZE = 1000;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data: page, error: postErr } = await supabase
        .from('lead_platform_posts')
        .select('group_id,posted_at,scraped_at')
        .eq('platform', 'facebook')
        .not('group_id', 'is', null)
        .range(offset, offset + PAGE_SIZE - 1);
      if (postErr) throw new Error(postErr.message);
      for (const row of page ?? []) {
        const gid = row.group_id as string | null;
        if (!gid) continue;
        const ts = (row.posted_at ?? row.scraped_at) as string | null;
        const entry = postCounts.get(gid) ?? { count: 0, lastSeen: null };
        entry.count += 1;
        if (ts && (!entry.lastSeen || ts > entry.lastSeen)) entry.lastSeen = ts;
        postCounts.set(gid, entry);
      }
      if (!page || page.length < PAGE_SIZE) break;
    }

    const enriched = (groupRows ?? []).map((g) => {
      const stats = postCounts.get(g.group_id as string) ?? { count: 0, lastSeen: null };
      return { ...g, post_count: stats.count, last_post_seen: stats.lastSeen };
    });

    // Most productive first: post_count desc, then most recently active,
    // nulls (never-posted groups, e.g. the 55-row browser-crawl seed with
    // no matching post yet) sink to the bottom of their count tier.
    enriched.sort((a, b) => {
      if (b.post_count !== a.post_count) return b.post_count - a.post_count;
      if (a.last_post_seen && b.last_post_seen) return b.last_post_seen.localeCompare(a.last_post_seen);
      if (a.last_post_seen) return -1;
      if (b.last_post_seen) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── POST /api/social-groups/label ─────────────────────────────────────
//
// Spawns tools/scraper/label_fb_groups.py, which labels every currently-
// unlabelled group (audience IS NULL) in one batched Gemini pass and
// writes audience + location back. Idempotent: a group already labelled
// is never re-labelled, so calling this repeatedly only ever costs a
// cheap empty SELECT once the backlog is clear.
router.post('/label', async (_req: Request, res: Response) => {
  const PYTHON_RAW = config.pythonPath || 'python';
  const PYTHON = path.isAbsolute(PYTHON_RAW) ? PYTHON_RAW : path.resolve(config.projectRoot, PYTHON_RAW);

  try {
    const result = await new Promise<{ labelled: number; total_unlabelled: number; results: unknown[] }>(
      (resolve, reject) => {
        const child = spawn(
          PYTHON,
          ['-u', '-m', 'tools.scraper.label_fb_groups', '--json'],
          {
            cwd: config.projectRoot,
            env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.on('error', (err) => reject(new Error(`spawn error: ${err.message}`)));
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        child.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`python exited with code ${code}: ${(stderr.trim() || stdout.trim()).slice(0, 500)}`));
            return;
          }
          const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
          const lastLine = lines[lines.length - 1];
          try {
            resolve(JSON.parse(lastLine));
          } catch {
            reject(new Error(`unparseable python output: ${(lastLine || '').slice(0, 200)}`));
          }
        });
      },
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;

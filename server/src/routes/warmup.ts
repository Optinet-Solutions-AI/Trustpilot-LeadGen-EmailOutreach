/**
 * Warmup API routes
 *
 * GET  /api/warmup/status          — per-account warmup stats + pool health
 * POST /api/warmup/:email/toggle   — enable or disable warmup for an account
 * POST /api/warmup/:email/target   — update daily target for an account
 * POST /api/warmup/tick            — manually trigger one warmup tick (debug)
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { getWarmupStats, runWarmupTick } from '../services/warmup-scheduler.js';

const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

const router = Router();

// GET /api/warmup/status
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();

    const { data: accounts, error } = await supabase
      .from('email_accounts')
      .select('email, from_name, status, auth_type, is_cold_sender, warmup_enabled, warmup_daily_target, warmup_started_at, warmup_target_cap, warmup_ramp_days')
      .in('auth_type', ['gmail_oauth', 'smtp', 'app_password'])
      .order('created_at');

    if (error) throw new Error(error.message);

    const stats = await getWarmupStats();

    const result = (accounts ?? []).map(acc => ({
      email:             acc.email,
      fromName:          acc.from_name,
      status:            acc.status,
      authType:          acc.auth_type,
      isColdSender:      acc.is_cold_sender ?? true,
      warmupEnabled:     acc.warmup_enabled,
      warmupDailyTarget: acc.warmup_daily_target,
      warmupStartedAt:   acc.warmup_started_at ?? null,
      warmupTargetCap:   acc.warmup_target_cap ?? 50,
      warmupRampDays:    acc.warmup_ramp_days  ?? 21,
      sentToday:         stats[acc.email]?.sentToday      ?? 0,
      totalSent:         stats[acc.email]?.totalSent      ?? 0,
      totalCompleted:    stats[acc.email]?.totalCompleted ?? 0,
      lastSentAt:        stats[acc.email]?.lastSentAt     ?? null,
      inPool:            acc.warmup_enabled && acc.status === 'active',
    }));

    const poolSize = result.filter(a => a.inPool).length;

    // ── Pipeline snapshot: count warmup_emails by stage in the last 24h ──
    // Lets the UI show where each batch is in the send → open → reply → read cycle
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: pipelineRows } = await supabase
      .from('warmup_emails')
      .select('stage, sent_at')
      .gte('sent_at', since24h);

    const pipeline = { pending_open: 0, pending_reply: 0, pending_read: 0, complete: 0, failed: 0 };
    let lastActivityAt: string | null = null;
    for (const row of (pipelineRows ?? []) as Array<{ stage: string; sent_at: string }>) {
      if (row.stage in pipeline) (pipeline as Record<string, number>)[row.stage] += 1;
      if (!lastActivityAt || row.sent_at > lastActivityAt) lastActivityAt = row.sent_at;
    }
    const totalLast24h = Object.values(pipeline).reduce((a, b) => a + b, 0);

    res.json({
      success: true,
      data: {
        accounts: result,
        poolSize,
        healthy: poolSize >= 2,
        warning: poolSize < 2
          ? `Need at least 2 accounts in the warmup pool (currently ${poolSize}). Add more sending accounts or warmup peers.`
          : null,
        pipeline: {
          ...pipeline,
          totalLast24h,
          lastActivityAt,
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/warmup/:email/toggle  — body: { enabled: boolean }
// On first enable, warmup_started_at is stamped to NOW() and stays sticky
// across subsequent toggles. Use /restart-ramp to reset the ramp clock.
router.post('/:email/toggle', async (req: Request, res: Response) => {
  try {
    const email  = decodeURIComponent(param(req.params.email));
    const { enabled } = req.body as { enabled: boolean };

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: '`enabled` (boolean) is required' });
      return;
    }

    const supabase = getSupabase();

    // Look up current state — we only stamp warmup_started_at on first-ever enable.
    const { data: existing, error: lookupErr } = await supabase
      .from('email_accounts')
      .select('email, warmup_started_at')
      .eq('email', email)
      .single();

    if (lookupErr) throw new Error(lookupErr.message);
    if (!existing) throw new Error('Account not found');

    const updates: Record<string, unknown> = { warmup_enabled: enabled };
    if (enabled && !existing.warmup_started_at) {
      updates.warmup_started_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('email_accounts')
      .update(updates)
      .eq('email', email)
      .select('email, warmup_enabled, warmup_started_at')
      .single();

    if (error) throw new Error(error.message);

    console.log(`[Warmup] ${enabled ? 'Enabled' : 'Disabled'} warmup for ${email}`);
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/warmup/:email/restart-ramp — reset warmup_started_at to NOW()
// Use when an account's reputation got nuked and you want to start the ramp over.
router.post('/:email/restart-ramp', async (req: Request, res: Response) => {
  try {
    const email = decodeURIComponent(param(req.params.email));

    const { data, error } = await getSupabase()
      .from('email_accounts')
      .update({ warmup_started_at: new Date().toISOString() })
      .eq('email', email)
      .select('email, warmup_started_at')
      .single();

    if (error) throw new Error(error.message);
    if (!data)  throw new Error('Account not found');

    console.log(`[Warmup] Restarted ramp for ${email}`);
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/warmup/:email/target  — body: { dailyTarget: number }
router.post('/:email/target', async (req: Request, res: Response) => {
  try {
    const email       = decodeURIComponent(param(req.params.email));
    const dailyTarget = parseInt(req.body.dailyTarget, 10);

    if (isNaN(dailyTarget) || dailyTarget < 1 || dailyTarget > 50) {
      res.status(400).json({ success: false, error: 'dailyTarget must be between 1 and 50' });
      return;
    }

    const { data, error } = await getSupabase()
      .from('email_accounts')
      .update({ warmup_daily_target: dailyTarget })
      .eq('email', email)
      .select('email, warmup_daily_target')
      .single();

    if (error) throw new Error(error.message);

    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/warmup/tick — manually trigger one tick (for testing/debugging)
router.post('/tick', async (_req: Request, res: Response) => {
  try {
    await runWarmupTick();
    res.json({ success: true, data: { message: 'Warmup tick completed' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

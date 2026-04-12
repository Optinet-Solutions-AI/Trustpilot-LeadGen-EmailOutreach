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

    // All OAuth2 accounts with warmup columns
    const { data: accounts, error } = await supabase
      .from('email_accounts')
      .select('email, from_name, status, auth_type, warmup_enabled, warmup_daily_target')
      .eq('auth_type', 'gmail_oauth')
      .order('created_at');

    if (error) throw new Error(error.message);

    const stats = await getWarmupStats();

    const result = (accounts ?? []).map(acc => ({
      email:            acc.email,
      fromName:         acc.from_name,
      status:           acc.status,
      warmupEnabled:    acc.warmup_enabled,
      warmupDailyTarget: acc.warmup_daily_target,
      sentToday:        stats[acc.email]?.sentToday        ?? 0,
      totalSent:        stats[acc.email]?.totalSent        ?? 0,
      totalCompleted:   stats[acc.email]?.totalCompleted   ?? 0,
      lastSentAt:       stats[acc.email]?.lastSentAt       ?? null,
      inPool:           acc.warmup_enabled && acc.status === 'active',
    }));

    const poolSize = result.filter(a => a.inPool).length;

    res.json({
      success: true,
      data: {
        accounts: result,
        poolSize,
        healthy: poolSize >= 2,
        warning: poolSize < 2
          ? `Need at least 2 accounts in the warmup pool (currently ${poolSize}). Add more Gmail OAuth2 accounts.`
          : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/warmup/:email/toggle
router.post('/:email/toggle', async (req: Request, res: Response) => {
  try {
    const email  = decodeURIComponent(param(req.params.email));
    const { enabled } = req.body as { enabled: boolean };

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: '`enabled` (boolean) is required' });
      return;
    }

    const { data, error } = await getSupabase()
      .from('email_accounts')
      .update({ warmup_enabled: enabled })
      .eq('email', email)
      .eq('auth_type', 'gmail_oauth')
      .select('email, warmup_enabled')
      .single();

    if (error) throw new Error(error.message);
    if (!data)  throw new Error('Account not found or not a Gmail OAuth2 account');

    console.log(`[Warmup] ${enabled ? 'Enabled' : 'Disabled'} warmup for ${email}`);
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

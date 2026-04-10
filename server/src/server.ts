import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';

import scrapeRoutes from './routes/scrape.js';
import leadsRoutes from './routes/leads.js';
import campaignsRoutes from './routes/campaigns.js';
import verifyRoutes from './routes/verify.js';
import enrichRoutes from './routes/enrich.js';
import notesRoutes from './routes/notes.js';
import followUpsRoutes from './routes/follow-ups.js';
import analyticsRoutes from './routes/analytics.js';
import gmailRoutes from './routes/gmail.js';
import webhookRoutes from './routes/webhooks.js';

const app = express();

// CORS — must come first and handle OPTIONS preflight explicitly
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
  optionsSuccessStatus: 200, // Some browsers (IE11) choke on 204
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions)); // Explicitly handle all preflight requests

app.use(express.json());

// Webhook routes — BEFORE auth middleware (external platforms need to reach these)
app.use('/api/webhooks', webhookRoutes);

app.use(authMiddleware);

// Routes
app.use('/api/scrape', scrapeRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/leads', notesRoutes);       // /api/leads/:leadId/notes
app.use('/api/leads', followUpsRoutes);   // /api/leads/:leadId/follow-ups (nested)
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/verify', verifyRoutes);
app.use('/api/enrich', enrichRoutes);
app.use('/api/follow-ups', followUpsRoutes);  // /api/follow-ups (top-level for dashboard)
app.use('/api/analytics', analyticsRoutes);
app.use('/api/gmail', gmailRoutes);

// Serve screenshots as static files
app.use('/api/screenshots', express.static(
  path.resolve(config.projectRoot, '.tmp', 'screenshots')
));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', emailMode: config.emailMode } });
});

// Error handler (must be last)
app.use(errorHandler);

const server = app.listen(config.port, async () => {
  console.log(`API server running on http://localhost:${config.port}`);
  console.log(`Email mode: ${config.emailMode}`);

  // On startup, reset any orphaned 'sending' campaigns back to 'draft'.
  // This happens when Cloud Run kills the old instance mid-send and deploys a new one.
  try {
    const { getSupabase } = await import('./lib/supabase.js');
    // Only reset Gmail/direct campaigns — platform campaigns (platform_campaign_id IS NOT NULL)
    // are still being handled by Instantly and should stay as 'sending'.
    const { error } = await getSupabase()
      .from('campaigns')
      .update({ status: 'draft' })
      .eq('status', 'sending')
      .is('platform_campaign_id', null);
    if (error) console.warn('[Startup] Failed to reset orphaned campaigns:', error.message);
    else console.log('[Startup] Reset orphaned direct-send campaigns to draft (platform campaigns untouched)');
  } catch (e) {
    console.error('[Startup] Orphan reset error:', e instanceof Error ? e.message : e);
  }

  // Reset truly orphaned 'running' scrape jobs to 'failed' on startup.
  // Only mark jobs as orphaned if they started more than 30 minutes ago,
  // to avoid killing jobs that are actively running on this or another instance.
  try {
    const { getSupabase } = await import('./lib/supabase.js');
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data, error } = await getSupabase()
      .from('scrape_jobs')
      .update({ status: 'failed', error: 'Server restarted during job' })
      .eq('status', 'running')
      .lt('started_at', thirtyMinAgo)
      .select('id');
    if (error) console.warn('[Startup] Failed to reset orphaned scrape jobs:', error.message);
    else {
      const count = data?.length ?? 0;
      if (count > 0) console.log(`[Startup] Reset ${count} orphaned scrape jobs (started >30min ago) to failed`);
      else console.log('[Startup] No orphaned scrape jobs found');
    }
  } catch (e) {
    console.error('[Startup] Scrape job orphan reset error:', e instanceof Error ? e.message : e);
  }

  // Start email platform sync job (polling for campaign stats)
  if (config.emailPlatform !== 'none') {
    const syncInterval = config.emailPlatform === 'instantly'
      ? config.instantly.syncInterval
      : 120_000; // default 2 minutes
    setInterval(async () => {
      try {
        const { syncAllActiveCampaigns } = await import('./services/platform-sync.js');
        await syncAllActiveCampaigns();
      } catch (e) {
        console.error('[PlatformSync] Poll error:', e instanceof Error ? e.message : e);
      }
    }, syncInterval);
    console.log(`Email platform: ${config.emailPlatform} (sync every ${syncInterval / 1000}s)`);
  }

  // Start sequence scheduler for follow-up emails (direct/Gmail mode only)
  try {
    const { startSequenceScheduler } = await import('./services/sequence-scheduler.js');
    startSequenceScheduler();
  } catch (e) {
    console.error('[Startup] Sequence scheduler error:', e instanceof Error ? e.message : e);
  }

  // Start Gmail reply tracking poll (every 5 minutes) when in gmail mode
  if (config.emailMode === 'gmail') {
    const REPLY_CHECK_INTERVAL = 5 * 60 * 1000;
    setInterval(async () => {
      try {
        const { checkForReplies } = await import('./services/reply-tracker.js');
        const { repliesFound } = await checkForReplies();
        if (repliesFound > 0) console.log(`[ReplyTracker] Found ${repliesFound} new replies`);
      } catch (e) {
        console.error('[ReplyTracker] Poll error:', e instanceof Error ? e.message : e);
      }
    }, REPLY_CHECK_INTERVAL);
    console.log('Reply tracker: polling every 5 minutes');
  }
});

// Graceful shutdown — Cloud Run sends SIGTERM before killing the instance.
// Kill active Python processes and mark running jobs as failed.
process.on('SIGTERM', async () => {
  console.log('SIGTERM received — killing active scrapers and shutting down');

  // Kill all active Python scraper processes
  try {
    const { getActiveProcesses } = await import('./services/scrape-runner.js');
    for (const [jobId, proc] of getActiveProcesses()) {
      console.log(`  Killing scraper process for job ${jobId} (PID ${proc.pid})`);
      try {
        if (process.platform === 'win32') {
          const { spawn } = await import('child_process');
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
        } else {
          proc.kill('SIGTERM');
        }
      } catch {}
    }
  } catch {}

  // Mark all running scrape jobs as failed in DB
  try {
    const { getSupabase } = await import('./lib/supabase.js');
    const supabase = getSupabase();
    await supabase
      .from('scrape_jobs')
      .update({ status: 'failed', error: 'Server shutdown during job' })
      .eq('status', 'running');
  } catch (e) {
    console.error('Failed to clean up running jobs on shutdown:', e);
  }
  server.close(() => process.exit(0));
});

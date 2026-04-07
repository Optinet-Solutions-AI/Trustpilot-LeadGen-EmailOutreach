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

const server = app.listen(config.port, () => {
  console.log(`API server running on http://localhost:${config.port}`);
  console.log(`Email mode: ${config.emailMode}`);

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
// Mark any running scrape jobs as failed so the UI doesn't show them stuck.
process.on('SIGTERM', async () => {
  console.log('SIGTERM received — marking running jobs as failed and shutting down');
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

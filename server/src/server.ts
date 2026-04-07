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
import notesRoutes from './routes/notes.js';
import followUpsRoutes from './routes/follow-ups.js';
import analyticsRoutes from './routes/analytics.js';

const app = express();

// CORS — must come first and handle OPTIONS preflight explicitly
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
  optionsSuccessStatus: 200, // Some browsers (IE11) choke on 204
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Explicitly handle all preflight requests

app.use(express.json());
app.use(authMiddleware);

// Routes
app.use('/api/scrape', scrapeRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/leads', notesRoutes);       // /api/leads/:leadId/notes
app.use('/api/leads', followUpsRoutes);   // /api/leads/:leadId/follow-ups (nested)
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/verify', verifyRoutes);
app.use('/api/follow-ups', followUpsRoutes);  // /api/follow-ups (top-level for dashboard)
app.use('/api/analytics', analyticsRoutes);

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

app.listen(config.port, () => {
  console.log(`API server running on http://localhost:${config.port}`);
  console.log(`Email mode: ${config.emailMode}`);
});

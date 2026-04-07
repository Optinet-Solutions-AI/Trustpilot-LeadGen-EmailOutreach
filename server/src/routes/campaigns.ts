import { Router, Request, Response } from 'express';
import path from 'path';
import { getCampaigns, createCampaign, updateCampaign, addLeadsToCampaign, addLeadsByFilter, getCampaignLeads, getCampaignStats } from '../db/campaigns.js';
import { createNote } from '../db/notes.js';
import { renderTemplate } from '../services/template-engine.js';
import { runCampaignSend, campaignEvents } from '../services/campaign-sender.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { config } from '../config.js';
import fs from 'fs';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// GET /api/campaigns
router.get('/', async (_req: Request, res: Response) => {
  try {
    const campaigns = await getCampaigns();
    res.json({ success: true, data: campaigns });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/campaigns
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, templateSubject, templateBody, includeScreenshot = false, leadIds, filterCountry, filterCategory } = req.body;
    if (!name || !templateSubject || !templateBody) {
      res.status(400).json({ success: false, error: 'name, templateSubject, and templateBody are required' });
      return;
    }

    const campaign = await createCampaign({
      name,
      template_subject: templateSubject,
      template_body: templateBody,
      include_screenshot: includeScreenshot,
    });

    if (leadIds && leadIds.length > 0) {
      await addLeadsToCampaign(campaign.id, leadIds);
    } else {
      // Always run filter-based assignment — empty filters = all leads with a valid email
      await addLeadsByFilter(campaign.id, { country: filterCountry, category: filterCategory });
    }

    res.json({ success: true, data: campaign });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/campaigns/:id
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const campaign = await updateCampaign(param(req.params.id), req.body);
    res.json({ success: true, data: campaign });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/campaigns/:id/send — fire-and-forget async send
router.post('/:id/send', async (req: Request, res: Response) => {
  try {
    const campaignId = param(req.params.id);
    const { testMode, testEmail, limit } = req.body;

    const campaignLeads = await getCampaignLeads(campaignId);
    if (campaignLeads.length === 0) {
      res.status(400).json({ success: false, error: 'No leads in this campaign' });
      return;
    }

    const campaigns = await getCampaigns();
    const campaign = campaigns.find((c: { id: string }) => c.id === campaignId);
    if (!campaign) {
      res.status(404).json({ success: false, error: 'Campaign not found' });
      return;
    }

    const screenshotsDir = path.resolve(config.projectRoot, '.tmp', 'screenshots');

    // Build email list for async sender
    const emails = campaignLeads
      .filter((cl: { email_used: string | null; status: string }) => cl.email_used && cl.status === 'pending')
      .map((cl: { id: string; lead_id: string; email_used: string; leads: Record<string, unknown> }) => {
        const lead = cl.leads as Record<string, unknown>;
        const screenshotPath = campaign.include_screenshot && lead.screenshot_path
          ? path.resolve(screenshotsDir, path.basename(String(lead.screenshot_path)))
          : undefined;

        // Only include screenshot if file actually exists
        const validScreenshotPath = screenshotPath && fs.existsSync(screenshotPath)
          ? screenshotPath
          : undefined;

        return {
          campaignLeadId: cl.id,
          leadId: cl.lead_id,
          to: cl.email_used,
          subject: renderTemplate(campaign.template_subject, lead),
          html: renderTemplate(campaign.template_body, lead),
          screenshotPath: validScreenshotPath,
        };
      });

    if (emails.length === 0) {
      res.status(400).json({ success: false, error: 'No pending leads with valid emails in this campaign' });
      return;
    }

    // Optional limit — e.g. send only 1 lead for a quick test
    const emailsToSend = limit && Number(limit) > 0 ? emails.slice(0, Number(limit)) : emails;

    const isTestMode = testMode === true || config.testMode.enabled;

    // Fire and forget — respond immediately
    runCampaignSend({
      campaignId,
      campaignName: campaign.name,
      emails: emailsToSend,
      testMode: isTestMode,
      testEmailOverride: isTestMode && testEmail ? String(testEmail) : undefined,
    });

    res.json({
      success: true,
      data: {
        campaignId,
        emailCount: emailsToSend.length,
        testMode: isTestMode,
        message: `Campaign send started for ${emails.length} emails. Monitor progress via SSE.`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/campaigns/:id/send/status — SSE stream for campaign progress
router.get('/:id/send/status', (req: Request, res: Response) => {
  const campaignId = param(req.params.id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const handler = (event: Record<string, unknown>) => {
    if (event.campaignId !== campaignId) return;
    send(event);
    if (event.stage === 'completed' || event.stage === 'failed') {
      cleanup();
    }
  };

  const cleanup = () => {
    campaignEvents.removeListener('progress', handler);
    res.end();
  };

  campaignEvents.on('progress', handler);
  req.on('close', cleanup);

  // Send initial heartbeat
  send({ campaignId, stage: 'connected' });
});

// GET /api/campaigns/:id/stats
router.get('/:id/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getCampaignStats(param(req.params.id));
    res.json({ success: true, data: stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/campaigns/:id/leads — list all leads in a campaign with their status
router.get('/:id/leads', async (req: Request, res: Response) => {
  try {
    const leads = await getCampaignLeads(param(req.params.id));
    res.json({ success: true, data: leads });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/campaigns/:id/leads — add leads to campaign
router.post('/:id/leads', async (req: Request, res: Response) => {
  try {
    const { leadIds } = req.body;
    if (!leadIds || !Array.isArray(leadIds)) {
      res.status(400).json({ success: false, error: 'leadIds (array) is required' });
      return;
    }
    const data = await addLeadsToCampaign(param(req.params.id), leadIds);
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/campaigns/rate-limit — email rate limit status
router.get('/rate-limit', (_req: Request, res: Response) => {
  res.json({ success: true, data: rateLimiter.getStatus() });
});

// Suppress unused import warning — createNote is used by the old sync path; keep for future use
void createNote;

export default router;

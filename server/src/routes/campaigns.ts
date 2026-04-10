import { Router, Request, Response } from 'express';
import path from 'path';
import { getCampaigns, createCampaign, updateCampaign, deleteCampaign, addLeadsToCampaign, addLeadsByFilter, getCampaignLeads, getCampaignStats, getSentEmails, duplicateCampaign, previewRecipientCount } from '../db/campaigns.js';
import { getCampaignSteps, createCampaignSteps } from '../db/campaign-steps.js';
import { createNote } from '../db/notes.js';
import { renderAndSpin } from '../services/template-engine.js';
import { runCampaignSend, cancelCampaign, campaignEvents } from '../services/campaign-sender.js';
import { applyTestMode } from '../services/test-mode.js';
import { sendEmail } from '../services/email-sender.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { config } from '../config.js';
import { isPlatformEnabled, getEmailPlatform } from '../services/email-platform/index.js';
import { pushCampaignToPlatform } from '../services/platform-campaign-sender.js';
import { syncSingleCampaign } from '../services/platform-sync.js';
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
    const { name, templateSubject, templateBody, includeScreenshot = false, leadIds, filterCountry, filterCategory, followUpSteps } = req.body;
    if (!name || !templateSubject || !templateBody) {
      res.status(400).json({ success: false, error: 'name, templateSubject, and templateBody are required' });
      return;
    }

    const campaign = await createCampaign({
      name,
      template_subject: templateSubject,
      template_body: templateBody,
      include_screenshot: includeScreenshot,
      filter_country: filterCountry || undefined,
      filter_category: filterCategory || undefined,
    });

    // Save follow-up steps if provided (step 1 = initial email from campaign template)
    if (Array.isArray(followUpSteps) && followUpSteps.length > 0) {
      // Step 1 is the campaign's main template (already stored on campaigns table).
      // followUpSteps contains step 2, 3, 4... — the actual follow-ups.
      const stepsToInsert = followUpSteps.map((s: { delayDays: number; subject: string; body: string }, i: number) => ({
        step_number: i + 2,  // starts at 2 (step 1 = campaign template)
        delay_days: s.delayDays || 3,
        template_subject: s.subject,
        template_body: s.body,
      }));
      await createCampaignSteps(campaign.id, stepsToInsert);
    }

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

// GET /api/campaigns/preview-recipients — preview lead count + sample for given filters
// Must be before /:id routes to avoid Express matching "preview-recipients" as an id
router.get('/preview-recipients', async (req: Request, res: Response) => {
  try {
    const country = req.query.country ? String(req.query.country) : undefined;
    const category = req.query.category ? String(req.query.category) : undefined;
    const result = await previewRecipientCount({ country, category });
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/campaigns/rate-limit — email rate limit status
router.get('/rate-limit', (_req: Request, res: Response) => {
  res.json({ success: true, data: rateLimiter.getStatus() });
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

// DELETE /api/campaigns/:id — remove campaign and all its leads
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await deleteCampaign(param(req.params.id));
    res.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/campaigns/:id/test-flight — send an exact replica to a test address using real lead data
// Mandatory pre-flight gate before the user is allowed to blast a live campaign.
// Uses the EXACT same rendering + screenshot logic as production; does NOT update DB or fire the async sender.
router.post('/:id/test-flight', async (req: Request, res: Response) => {
  try {
    const campaignId = param(req.params.id);
    const { testEmail } = req.body;

    if (!testEmail || typeof testEmail !== 'string' || !testEmail.includes('@')) {
      res.status(400).json({ success: false, error: 'A valid testEmail address is required.' });
      return;
    }

    // Load campaign
    const allCampaigns = await getCampaigns();
    const campaign = allCampaigns.find((c: { id: string }) => c.id === campaignId);
    if (!campaign) {
      res.status(404).json({ success: false, error: 'Campaign not found.' });
      return;
    }

    // Grab first pending lead with a real email — used to populate template variables authentically
    const campaignLeads = await getCampaignLeads(campaignId);
    const firstPendingLead = campaignLeads.find(
      (cl: { email_used: string | null; status: string }) => cl.email_used && cl.status === 'pending'
    );
    if (!firstPendingLead) {
      res.status(400).json({ success: false, error: 'No pending leads with a valid email found in this campaign.' });
      return;
    }

    const lead = firstPendingLead.leads as Record<string, unknown>;

    // Render with real lead data — identical to how production emails are built
    const subject = renderAndSpin(campaign.template_subject, lead);
    const html    = renderAndSpin(campaign.template_body, lead);

    // Screenshot — resolve from URL (Supabase Storage) or local file
    const leadScreenshot = lead.screenshot_path ? String(lead.screenshot_path) : '';
    let validScreenshotPath: string | undefined;
    if (campaign.include_screenshot && leadScreenshot) {
      if (leadScreenshot.startsWith('http')) {
        validScreenshotPath = leadScreenshot; // Supabase Storage URL — fetched by email sender
      } else {
        const screenshotsDir = path.resolve(config.projectRoot, '.tmp', 'screenshots');
        const localPath = path.resolve(screenshotsDir, path.basename(leadScreenshot));
        if (fs.existsSync(localPath)) validScreenshotPath = localPath;
      }
    }

    // Override recipient + inject [TEST FLIGHT] banner — never touches the real lead's inbox
    const transformed = applyTestMode(
      { to: firstPendingLead.email_used as string, subject, html },
      true,       // force test mode on
      testEmail,  // override with caller-supplied address
    );

    // Send synchronously — we need to know immediately if it succeeded before unlocking the live send
    const result = await sendEmail(
      transformed.to,
      transformed.subject,
      transformed.html,
      { screenshotPath: validScreenshotPath }
    );

    if (!result.success) {
      res.status(500).json({ success: false, error: result.error || 'Email delivery failed.' });
      return;
    }

    res.json({
      success: true,
      data: {
        sentTo: testEmail,
        leadUsed: String(lead.company_name || 'Unknown'),
        originalEmail: firstPendingLead.email_used,
        messageId: result.messageId,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/campaigns/:id/cancel — request stop of a running campaign
router.post('/:id/cancel', async (req: Request, res: Response) => {
  const campaignId = param(req.params.id);

  if (isPlatformEnabled()) {
    // Platform mode: pause the campaign on the platform
    try {
      const campaigns = await getCampaigns();
      const campaign = campaigns.find((c: { id: string }) => c.id === campaignId);
      if (campaign?.platform_campaign_id) {
        const platform = getEmailPlatform();
        await platform.pauseCampaign(campaign.platform_campaign_id);
        await updateCampaign(campaignId, { status: 'draft' });
        res.json({ success: true, data: { message: `Campaign paused on ${platform.name}.` } });
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: `Failed to pause on platform: ${message}` });
      return;
    }
  }

  // Direct mode: in-memory cancel
  cancelCampaign(campaignId);
  res.json({ success: true, data: { message: 'Cancel requested — will stop before next email.' } });
});

// POST /api/campaigns/:id/sync — trigger on-demand stats sync for platform campaigns
router.post('/:id/sync', async (req: Request, res: Response) => {
  try {
    const campaignId = param(req.params.id);
    await syncSingleCampaign(campaignId);
    const stats = await getCampaignStats(campaignId);
    res.json({ success: true, data: stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/campaigns/platform-status — check if a platform is configured and healthy
router.get('/platform-status', async (_req: Request, res: Response) => {
  if (!isPlatformEnabled()) {
    res.json({ success: true, data: { enabled: false, platform: 'none' } });
    return;
  }
  try {
    const platform = getEmailPlatform();
    const health = await platform.testConnection();
    res.json({ success: true, data: { enabled: true, platform: platform.name, ...health } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ success: true, data: { enabled: true, platform: config.emailPlatform, ok: false, error: message } });
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

    // Deduplication: collect emails already successfully sent in ANY campaign
    const alreadySent = await getSentEmails();

    // Filter to pending leads with valid, unsent emails
    const pendingLeads = campaignLeads.filter((cl: { email_used: string | null; status: string }) => {
      if (!cl.email_used || cl.status !== 'pending') return false;
      if (alreadySent.has(cl.email_used)) return false;
      return true;
    });

    if (pendingLeads.length === 0) {
      res.status(400).json({ success: false, error: 'No pending leads with valid emails in this campaign' });
      return;
    }

    // ─── Platform mode: push to Instantly/Smartlead ───────────────
    if (isPlatformEnabled()) {
      const leadsToSend = limit && Number(limit) > 0 ? pendingLeads.slice(0, Number(limit)) : pendingLeads;

      // Push campaign to platform (async but we await the initial setup)
      const result = await pushCampaignToPlatform({
        campaignId,
        campaignName: campaign.name,
        campaign: {
          template_subject: campaign.template_subject,
          template_body: campaign.template_body,
          include_screenshot: campaign.include_screenshot,
        },
        campaignLeads: leadsToSend.map((cl: { id: string; lead_id: string; email_used: string; leads: Record<string, unknown> }) => ({
          id: cl.id,
          lead_id: cl.lead_id,
          email_used: cl.email_used,
          leads: cl.leads as Record<string, unknown>,
        })),
      });

      res.json({
        success: true,
        data: {
          campaignId,
          mode: 'platform',
          platform: getEmailPlatform().name,
          platformCampaignId: result.platformCampaignId,
          leadsQueued: result.leadsAdded,
          leadsSkipped: result.leadsSkipped,
          errors: result.errors.length,
          message: `Campaign pushed to ${getEmailPlatform().name}: ${result.leadsAdded} leads queued. Stats sync automatically.`,
        },
      });
      return;
    }

    // ─── Direct mode: send via Gmail/mock one-by-one ──────────────
    const screenshotsDir = path.resolve(config.projectRoot, '.tmp', 'screenshots');

    const emails = pendingLeads
      .map((cl: { id: string; lead_id: string; email_used: string; leads: Record<string, unknown> }) => {
        const lead = cl.leads as Record<string, unknown>;
        const leadScreenshotPath = lead.screenshot_path ? String(lead.screenshot_path) : '';
        let validScreenshotPath: string | undefined;
        if (campaign.include_screenshot && leadScreenshotPath) {
          if (leadScreenshotPath.startsWith('http')) {
            validScreenshotPath = leadScreenshotPath;
          } else {
            const localPath = path.resolve(screenshotsDir, path.basename(leadScreenshotPath));
            if (fs.existsSync(localPath)) validScreenshotPath = localPath;
          }
        }

        return {
          campaignLeadId: cl.id,
          leadId: cl.lead_id,
          to: cl.email_used,
          subject: renderAndSpin(campaign.template_subject, lead),
          html: renderAndSpin(campaign.template_body, lead),
          screenshotPath: validScreenshotPath,
        };
      });

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
        mode: 'direct',
        emailCount: emailsToSend.length,
        testMode: isTestMode,
        message: `Campaign send started for ${emailsToSend.length} emails. Monitor progress via SSE.`,
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

// POST /api/campaigns/:id/duplicate — create a copy of an existing campaign
router.post('/:id/duplicate', async (req: Request, res: Response) => {
  try {
    const sourceId = param(req.params.id);
    const campaign = await duplicateCampaign(sourceId);

    // Copy follow-up steps from the source campaign
    const steps = await getCampaignSteps(sourceId);
    if (steps.length > 0) {
      await createCampaignSteps(
        campaign.id,
        steps.map((s) => ({
          step_number: s.step_number,
          delay_days: s.delay_days,
          template_subject: s.template_subject,
          template_body: s.template_body,
        }))
      );
    }

    res.json({ success: true, data: campaign });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/campaigns/:id/steps — get follow-up steps for a campaign
router.get('/:id/steps', async (req: Request, res: Response) => {
  try {
    const steps = await getCampaignSteps(param(req.params.id));
    res.json({ success: true, data: steps });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// Suppress unused import warning — createNote is used by the old sync path; keep for future use
void createNote;

export default router;

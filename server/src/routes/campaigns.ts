import { Router, Request, Response } from 'express';
import { getCampaigns, createCampaign, updateCampaign, addLeadsToCampaign, addLeadsByFilter, getCampaignLeads, getCampaignStats } from '../db/campaigns.js';
import { createNote } from '../db/notes.js';
import { renderTemplate } from '../services/template-engine.js';
import { sendCampaignEmails } from '../services/email-sender.mock.js';

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
    } else if (filterCountry || filterCategory) {
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

// POST /api/campaigns/:id/send — send campaign emails
router.post('/:id/send', async (req: Request, res: Response) => {
  try {
    const campaignLeads = await getCampaignLeads(param(req.params.id));
    if (campaignLeads.length === 0) {
      res.status(400).json({ success: false, error: 'No leads in this campaign' });
      return;
    }

    // Get campaign template
    const campaigns = await getCampaigns();
    const campaign = campaigns.find((c: { id: string }) => c.id === param(req.params.id));
    if (!campaign) {
      res.status(404).json({ success: false, error: 'Campaign not found' });
      return;
    }

    // Build email list with rendered templates
    const emails = campaignLeads
      .filter((cl: { email_used: string | null; status: string }) => cl.email_used && cl.status === 'pending')
      .map((cl: { id: string; email_used: string; leads: Record<string, unknown> }) => ({
        campaignLeadId: cl.id,
        to: cl.email_used,
        subject: renderTemplate(campaign.template_subject, cl.leads as Record<string, unknown>),
        html: renderTemplate(campaign.template_body, cl.leads as Record<string, unknown>),
      }));

    const result = await sendCampaignEmails(param(req.params.id), emails);

    // Create activity notes for each sent email
    for (const cl of campaignLeads) {
      if (cl.email_used) {
        await createNote(cl.lead_id, {
          type: 'email_sent',
          content: `Campaign "${campaign.name}" email sent to ${cl.email_used}`,
          metadata: { campaign_id: param(req.params.id) },
        });
      }
    }

    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
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

export default router;

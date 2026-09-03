import { Router, Request, Response } from 'express';
import path from 'path';
import { getCampaigns, createCampaign, updateCampaign, deleteCampaign, addLeadsToCampaign, addLeadsByFilter, getCampaignLeads, getCampaignStats, getSentEmails, markCampaignLeadsSkipped, removeCampaignLeads, duplicateCampaign, previewRecipientCount } from '../db/campaigns.js';
import { upsertManualLeads, getLeadById } from '../db/leads.js';
import { getCampaignSteps, createCampaignSteps } from '../db/campaign-steps.js';
import { assignScheduledTimes, type SendingSchedule } from '../services/schedule-engine.js';
import { getSupabase } from '../lib/supabase.js';
import { createNote } from '../db/notes.js';
import { renderAndSpin, KNOWN_TOKENS } from '../services/template-engine.js';
import { runCampaignSend, cancelCampaign, campaignEvents } from '../services/campaign-sender.js';
import { applyTestMode } from '../services/test-mode.js';
import { sendEmail } from '../services/email-sender.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { config } from '../config.js';
import { isPlatformEnabled, getEmailPlatform } from '../services/email-platform/index.js';
import { pushCampaignToPlatform } from '../services/platform-campaign-sender.js';
import { syncSingleCampaign } from '../services/platform-sync.js';
import { gateSendersByDns, formatGateError } from '../services/sender-dns-gate.js';
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

// GET /api/campaigns/config/mode — expose app mode flags to the frontend
router.get('/config/mode', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      manualLeadsOnly: config.manualLeadsOnly,
      testMode: config.testMode.enabled,
      emailPlatform: config.emailPlatform,
      emailMode: config.emailMode,
    },
  });
});

// GET /api/campaigns/email-accounts — current sender account info for the Email Accounts page
router.get('/email-accounts', (_req: Request, res: Response) => {
  const status = rateLimiter.getStatus();
  const providerLabel =
    config.emailPlatform !== 'none' ? config.emailPlatform :
    config.emailMode === 'gmail' ? 'Gmail (Personal)' :
    config.emailMode === 'brevo' ? 'Brevo' : 'Mock';

  res.json({
    success: true,
    data: {
      accounts: [
        {
          email: config.gmail.fromEmail || config.brevo.fromEmail || 'Not configured',
          provider: providerLabel,
          status: 'active',
          dailySent: status.dailyCount,
          dailyCap: status.dailyCap,
          hourlyCap: status.hourlyCap,
          warmupDay: rateLimiter.getWarmupStatus().day,
          warmupStatus: config.testMode.enabled
            ? `Day ${rateLimiter.getWarmupStatus().day} — Test Phase`
            : `Day ${rateLimiter.getWarmupStatus().day} — ${rateLimiter.getWarmupStatus().phase}`,
        },
      ],
      platform: config.emailPlatform,
      testMode: config.testMode.enabled,
      manualLeadsOnly: config.manualLeadsOnly,
    },
  });
});

// Hard cap on how many recipients a single campaign POST may carry. Prevents a paste
// of tens of thousands of rows from locking up the endpoint on a synchronous upsert.
const MAX_CAMPAIGN_RECIPIENTS = 5000;

// POST /api/campaigns
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, templateSubject, templateBody, includeScreenshot = false, leadIds: rawLeadIds, manualEmails, filterCountry, filterCategory, followUpSteps, sendingSchedule, campaignType, parentCampaignId } = req.body;

    // Reject oversized arrays up front so we don't spend time parsing/validating them.
    const inboundLeadCount = Array.isArray(rawLeadIds) ? rawLeadIds.length : 0;
    const inboundManualCount = Array.isArray(manualEmails) ? manualEmails.length : 0;
    if (inboundLeadCount + inboundManualCount > MAX_CAMPAIGN_RECIPIENTS) {
      res.status(413).json({
        success: false,
        error: `Too many recipients (${inboundLeadCount + inboundManualCount}). Max ${MAX_CAMPAIGN_RECIPIENTS} per campaign — split into multiple campaigns or use filter-based assignment.`,
      });
      return;
    }

    // Resolve manual email entries into lead IDs before creating the campaign
    let leadIds: string[] = Array.isArray(rawLeadIds) ? rawLeadIds : [];
    if (Array.isArray(manualEmails) && manualEmails.length > 0) {
      const validEmails = manualEmails.filter((e: unknown) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (validEmails.length > 0) {
        const manualIds = await upsertManualLeads(validEmails);
        leadIds = [...new Set([...leadIds, ...manualIds])];
      }
    }

    // Manual-only mode: block filter-based assignment and scraped lead IDs
    if (config.manualLeadsOnly) {
      if (leadIds.length === 0) {
        res.status(400).json({ success: false, error: 'Manual-only mode active: add email addresses in the "Add Manually" tab.' });
        return;
      }
      // All leadIds must come from manual upsert (trustpilot_url starts with 'manual:')
      // This is enforced at send-time as well, so creation is allowed but filter assignment is skipped
    }

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
      sending_schedule: sendingSchedule || null,
      // Discovery follow-up campaigns target leads.discovered_email instead
      // of primary_email at send time. Defaults to 'outreach' so existing
      // create-call sites land on the unchanged code path.
      campaign_type: campaignType === 'discovery_followup' ? 'discovery_followup' : undefined,
      parent_campaign_id: parentCampaignId || undefined,
    });

    // Save follow-up steps if provided (step 1 = initial email from campaign template)
    if (Array.isArray(followUpSteps) && followUpSteps.length > 0) {
      const stepsToInsert = followUpSteps.map((s: { delayDays: number; subject: string; body: string }, i: number) => ({
        step_number: i + 2,
        delay_days: s.delayDays || 3,
        template_subject: s.subject,
        template_body: s.body,
      }));
      await createCampaignSteps(campaign.id, stepsToInsert);
    }

    if (leadIds && leadIds.length > 0) {
      await addLeadsToCampaign(campaign.id, leadIds);
    } else if (!config.manualLeadsOnly) {
      // Filter-based assignment only when manual-only mode is OFF
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

// ── Email preview ────────────────────────────────────────────────────────
// The exact markup the SMTP / Gmail / Ongage senders append for the embedded
// screenshot. Kept byte-identical (bar the src) so the preview shows the real
// thing; the senders use a cid: reference against an inline attachment, which
// a browser can't resolve, so the preview substitutes the public URL.
const PREVIEW_SCREENSHOT_IMG = (src: string) =>
  `\n<br/><img src="${src}" alt="Your Trustpilot Profile" style="width:100%;max-width:550px;height:auto;border:1px solid #e2e8f0;border-radius:8px;display:block;margin-top:12px;" />`;

// Mirrors OPT_OUT_LINE in email-sender.ongage.ts — only Ongage sends append it.
const PREVIEW_OPT_OUT_LINE =
  '<p style="font-size:11px;color:#9aa0a6;margin-top:16px;line-height:1.5;">' +
  'Prefer not to hear from me? Just reply and I’ll take you off my list.</p>';

/** Stand-in lead for previewing a template before any recipient is chosen.
 *  Deliberately plausible rather than blank, so token fallbacks ("your team",
 *  "below-average") don't masquerade as real rendering bugs. */
const PREVIEW_SAMPLE_LEAD: Record<string, unknown> = {
  company_name:  'Acme Corp',
  website_url:   'acmecorp.com',
  star_rating:   2.5,
  review_count:  47,
  category:      'Home Services',
  country:       'US',
  primary_email: 'contact@acmecorp.com',
};

// POST /api/campaigns/preview — render a template exactly as it would send.
//
// Stateless on purpose: the campaign wizard needs to preview a draft that has
// no campaigns row yet, so everything comes in on the body. This runs the SAME
// renderAndSpin the scheduler and test-flight use, which is the whole point —
// a preview that reimplemented token/spintax/locale resolution would drift and
// quietly stop matching what recipients actually receive.
//
// Must sit before the /:id routes or Express matches "preview" as a campaign id.
router.post('/preview', async (req: Request, res: Response) => {
  try {
    const {
      subject = '',
      body = '',
      leadId,
      campaignId,
      includeScreenshot = false,
      senderAccountId,
    } = req.body ?? {};

    if (typeof subject !== 'string' || typeof body !== 'string' || (!subject.trim() && !body.trim())) {
      res.status(400).json({ success: false, error: 'A subject or body is required to preview.' });
      return;
    }

    const warnings: string[] = [];

    // ── Resolve the recipient the preview renders against ──
    // Explicit lead wins; then the campaign's first pending lead; then a
    // sample. Real lead data is what makes the preview worth trusting.
    let lead: Record<string, unknown> = PREVIEW_SAMPLE_LEAD;
    // null when the resolved lead genuinely has no address — the UI says so
    // plainly rather than rendering a fake one.
    let recipientEmail: string | null = String(PREVIEW_SAMPLE_LEAD.primary_email);
    let isSample = true;

    if (leadId && typeof leadId === 'string') {
      try {
        const found = await getLeadById(leadId);
        if (found) {
          lead = found as Record<string, unknown>;
          recipientEmail = String(lead.primary_email || lead.website_email || lead.trustpilot_email || '') || null;
          isSample = false;
        }
      } catch {
        warnings.push('That lead could not be loaded, so the preview uses sample data.');
      }
    } else if (campaignId && typeof campaignId === 'string') {
      try {
        const campaignLeads = await getCampaignLeads(campaignId);
        const first = campaignLeads.find((cl: { email_used: string | null }) => cl.email_used)
          ?? campaignLeads[0];
        if (first?.leads) {
          lead = first.leads as Record<string, unknown>;
          recipientEmail = String(first.email_used || lead.primary_email || '') || null;
          isSample = false;
        }
      } catch {
        warnings.push('This campaign’s leads could not be loaded, so the preview uses sample data.');
      }
    }

    // ── Render through the production path ──
    // renderAndSpin = tokens → spintax → locale, same as every real send.
    // Spintax picks randomly per call, so each request is a genuine variant.
    const renderedSubject = renderAndSpin(subject, lead);
    let renderedHtml      = renderAndSpin(body, lead);

    // ── Screenshot: only public Storage URLs survive to send time ──
    const leadScreenshotPath = lead.screenshot_path ? String(lead.screenshot_path) : '';
    let screenshotUrl: string | undefined;
    if (includeScreenshot) {
      if (leadScreenshotPath.startsWith('http')) {
        screenshotUrl = leadScreenshotPath;
        renderedHtml += PREVIEW_SCREENSHOT_IMG(screenshotUrl);
      } else if (leadScreenshotPath) {
        warnings.push('Screenshot is on an expired local path, not public storage — the real email will send without it.');
      } else if (isSample) {
        // The stand-in lead carries no screenshot, so the preview shows none.
        // Without this the panel looks like the screenshot setting is broken,
        // which is exactly how it reads to an operator who hasn't picked
        // recipients yet.
        warnings.push('Screenshot is on, but no lead is selected — the stand-in has none. Pick recipients to see the real screenshot that gets embedded.');
      } else {
        warnings.push('This lead has no screenshot, so the real email will send without one.');
      }
    }

    // ── Sender identity + provider-specific footer ──
    let fromEmail = config.gmail.fromEmail || 'not configured';
    let fromName  = process.env.EMAIL_FROM_NAME?.trim() || 'OptiRate';
    if (senderAccountId && typeof senderAccountId === 'string' && senderAccountId !== '__env__') {
      try {
        const { data: acc } = await (await import('../lib/supabase.js')).getSupabase()
          .from('email_accounts')
          .select('email, from_name, auth_type')
          .eq('id', senderAccountId)
          .single();
        if (acc) {
          fromEmail = acc.email;
          if (acc.from_name) fromName = acc.from_name;
          // Ongage is the only sender that appends its own opt-out line.
          if (acc.auth_type === 'ongage') renderedHtml += `\n${PREVIEW_OPT_OUT_LINE}`;
        }
      } catch {
        warnings.push('The pinned sending account could not be loaded; the From line is a fallback.');
      }
    }

    // Malformed-spintax detection has to look at the SOURCE template, not the
    // rendered output: resolveSpintax consumes every brace it sees, so a broken
    // group like "{Hi|Hello {{company_name}}" renders as the literal
    // "Hi|Hello Acme Corp" with no brace left to find. Unbalanced braces in the
    // input, or a bare pipe surviving into the output, are the real signals.
    const braceBalance = (subject + body).split('{').length - (subject + body).split('}').length;
    if (braceBalance !== 0) {
      warnings.push('The template has unbalanced { } braces, so spintax will render incorrectly. Regenerate or fix it before sending.');
    }
    if (/\w\s*\|\s*\w/.test(renderedHtml) || /\w\s*\|\s*\w/.test(renderedSubject)) {
      warnings.push('A "|" survived into the rendered email — a spintax group is malformed and recipients would see both options.');
    }
    // Unknown tokens must also be caught on the SOURCE. renderTemplate leaves
    // an unrecognised {{token}} as-is, then resolveSpintax strips its braces,
    // so by render time "{{websites}}" is just the word "websites".
    const usedTokens = [...(subject + body).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    const unknownTokens = [...new Set(usedTokens.filter((t) => !KNOWN_TOKENS.includes(t)))];
    if (unknownTokens.length > 0) {
      warnings.push(
        `Unknown token${unknownTokens.length > 1 ? 's' : ''} ${unknownTokens.map((t) => `{{${t}}}`).join(', ')} — ` +
        'these do not resolve and reach the recipient as bare words. Remove or correct them.',
      );
    }

    res.json({
      success: true,
      data: {
        subject: renderedSubject,
        html: renderedHtml,
        to: recipientEmail,
        fromEmail,
        fromName,
        companyName: String(lead.company_name || 'Unknown'),
        screenshotUrl: screenshotUrl ?? null,
        isSample,
        warnings,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/campaigns/sent-emails — global "already contacted" set
// Used by the campaign wizard's StepRecipients to badge leads whose primary
// email was already emailed in any prior campaign (sent/opened/replied/
// auto_replied/bounced). Lowercased so the frontend can match against
// lead.primary_email.toLowerCase() without normalising itself.
router.get('/sent-emails', async (_req: Request, res: Response) => {
  try {
    const set = await getSentEmails();
    res.json({ success: true, data: Array.from(set) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/campaigns/rate-limit — email rate limit status
router.get('/rate-limit', (_req: Request, res: Response) => {
  res.json({ success: true, data: rateLimiter.getStatus() });
});

// GET /api/campaigns/warmup-status — sender warmup progress
router.get('/warmup-status', (_req: Request, res: Response) => {
  res.json({ success: true, data: rateLimiter.getWarmupStatus() });
});

// PATCH /api/campaigns/:id
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const campaignId = param(req.params.id);
    const campaign = await updateCampaign(campaignId, req.body);

    // ── Re-apply the schedule to recipients that have not gone out yet ────
    //
    // Editing the sending window used to change NOTHING for a live campaign:
    // every pending recipient keeps the scheduled_at stamped at launch, so
    // lowering the daily limit, narrowing the hours or dropping a weekday had
    // no effect on the queue it was supposed to govern. The operator's
    // reasonable expectation is that an edit applies to whatever is still
    // pending, so that is what it now does.
    //
    // Sent rows are never touched -- those emails have left. Only rows still
    // at status='pending' with a scheduled_at are re-planned, and they keep
    // their existing order so the queue is re-paced rather than reshuffled.
    let rescheduled = 0;
    if (req.body?.sending_schedule) {
      try {
        rescheduled = await reschedulePendingLeads(campaignId, req.body.sending_schedule);
      } catch (e) {
        // An edit that saved but could not re-plan must not look like a
        // failure -- report it instead of throwing the whole PATCH away.
        console.warn('[Campaigns] Reschedule after edit failed:', e instanceof Error ? e.message : e);
      }
    }

    res.json({ success: true, data: campaign, rescheduled });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * Re-plan every still-pending recipient of a campaign against a new schedule.
 * Returns how many rows were moved. Order is preserved (oldest scheduled_at
 * first) so re-pacing does not shuffle who gets contacted first.
 */
async function reschedulePendingLeads(
  campaignId: string,
  schedule: SendingSchedule,
): Promise<number> {
  const supabase = getSupabase();

  const { data: pending, error } = await supabase
    .from('campaign_leads')
    .select('id, scheduled_at')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .eq('channel', 'email')
    .not('scheduled_at', 'is', null)
    .order('scheduled_at', { ascending: true });
  if (error) throw new Error(error.message);
  if (!pending || pending.length === 0) return 0;

  // dailyLimit is per account, so the plan needs the mailbox count -- the same
  // resolution the launch path uses.
  const pinned = (schedule as unknown as { senderAccountIds?: string[]; senderAccountId?: string });
  const ids = pinned?.senderAccountIds ?? (pinned?.senderAccountId ? [pinned.senderAccountId] : []);
  let senderCount = ids.length;
  if (senderCount === 0) {
    const { count } = await supabase
      .from('email_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .eq('is_cold_sender', true);
    senderCount = Math.max(1, count ?? 1);
  }

  const times = assignScheduledTimes(pending.length, schedule, new Date(), senderCount);

  const writes = pending.map((row: { id: string }, i: number) => {
    const t = times[i];
    if (!t) return Promise.resolve();
    return supabase
      .from('campaign_leads')
      .update({ scheduled_at: t.toISOString() })
      .eq('id', row.id)
      // Guard against a race with the scheduler claiming the row mid-edit.
      .eq('status', 'pending');
  });
  await Promise.allSettled(writes);
  return Math.min(pending.length, times.length);
}

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
// When EMAIL_PLATFORM=instantly, sends via Instantly (jordi@optiratesolutions.com) instead of Gmail.
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

    // ─── DNS gate: refuse if any pinned SMTP sender's domain is failing ──
    {
      const schedule = campaign.sending_schedule as Record<string, unknown> | null;
      const pinnedIds = (schedule?.senderAccountIds as string[] | undefined)
        ?? (schedule?.senderAccountId ? [schedule.senderAccountId as string] : []);
      if (pinnedIds.length > 0) {
        const gate = await gateSendersByDns(pinnedIds);
        if (!gate.ok) {
          res.status(400).json({ success: false, error: formatGateError(gate), dnsGate: gate });
          return;
        }
      }
    }

    const lead = firstPendingLead.leads as Record<string, unknown>;

    // Render with real lead data — identical to how production emails are built
    const renderedSubject = renderAndSpin(campaign.template_subject, lead);
    const renderedHtml    = renderAndSpin(campaign.template_body, lead);

    // Screenshot handling — only use persistent public URLs (Supabase Storage).
    // Legacy /app/.tmp/ paths are ephemeral Cloud Run container paths whose files
    // are gone by the time a campaign sends, and Thum.io blocks Cloud Run egress IPs
    // with 403. If there's no public URL, the email goes without a screenshot.
    const leadScreenshotPath = lead.screenshot_path ? String(lead.screenshot_path) : '';
    let screenshotUrl: string | undefined;
    if (campaign.include_screenshot && leadScreenshotPath.startsWith('http')) {
      screenshotUrl = leadScreenshotPath;
    } else if (campaign.include_screenshot && leadScreenshotPath) {
      console.warn(`[TestFlight] Lead ${lead.id} has non-public screenshot_path (${leadScreenshotPath}) — sending without screenshot. Re-scrape or run fix_screenshots.mjs to backfill.`);
    }

    // ── Platform mode: send test via Instantly ────────────────────────
    if (isPlatformEnabled()) {
      const platform = getEmailPlatform();
      const testCampaignName = `[TEST FLIGHT] ${campaign.name} ${Date.now()}`;

      // Build body with screenshot embedded if applicable
      let testBody = renderedHtml;
      if (screenshotUrl) {
        testBody += `<br/><img src="${screenshotUrl}" alt="Trustpilot Profile" style="max-width:600px;border-radius:8px;margin-top:16px;" />`;
      }
      const testSubject = `Test mode- ${renderedSubject}`;

      // Create a temporary 1-lead campaign on Instantly.
      // sendingAccounts: [] → skip email_list so Instantly uses ALL connected accounts
      //   (avoids failure if INSTANTLY_SENDING_ACCOUNTS points to an unconnected account).
      // Schedule: 00:00–23:59 all days → sends immediately regardless of time.
      const tempCampaign = await platform.createCampaign({
        name: testCampaignName,
        sequences: [{ subject: '{{custom_subject}}', body: '{{custom_body}}' }],
        stopOnReply: false,
        trackOpens: false,
        sendingAccounts: [],  // use any connected account
        schedule: {
          timezone: 'America/Detroit',
          startHour: '00:00',
          endHour: '23:59',
          days: [0, 1, 2, 3, 4, 5, 6],
          dailyLimit: 10,
        },
      });

      // Add the test recipient as the single lead
      await platform.addLeads(tempCampaign.platformCampaignId, [{
        email: testEmail,
        companyName: String(lead.company_name || ''),
        variables: {
          custom_subject: testSubject,
          custom_body: testBody,
        },
      }]);

      // Activate — Instantly will send it within the next sending window
      await platform.activateCampaign(tempCampaign.platformCampaignId);

      // Schedule cleanup: delete the temp campaign after 30 minutes
      setTimeout(async () => {
        try { await platform.deleteCampaign(tempCampaign.platformCampaignId); } catch {}
      }, 30 * 60 * 1000);

      console.log(`[TestFlight] Sent via ${platform.name} to ${testEmail} (temp campaign ${tempCampaign.platformCampaignId})`);

      res.json({
        success: true,
        data: {
          sentTo: testEmail,
          leadUsed: String(lead.company_name || 'Unknown'),
          originalEmail: firstPendingLead.email_used,
          platform: platform.name,
          note: `Queued via ${platform.name} — arrives within a few minutes depending on your sending schedule.`,
        },
      });
      return;
    }

    // ── Direct mode: send via Gmail ───────────────────────────────────
    // screenshotUrl already resolved above (Thum.io or stored URL)
    const validScreenshotPath = screenshotUrl;

    // Resolve the first pinned sender account from the campaign's sending_schedule.
    // Supports Gmail OAuth2, App Password (OAuth), and SMTP account types.
    let senderAccount: import('../services/email-sender.js').SenderAccount | undefined;
    const scheduleData = campaign.sending_schedule as Record<string, unknown> | null;
    const pinnedIds = (scheduleData?.senderAccountIds as string[] | undefined) ?? [];
    const pinnedId = pinnedIds.find((id) => id !== '__env__') ?? (scheduleData?.senderAccountId as string | undefined);
    if (pinnedId && pinnedId !== '__env__') {
      try {
        const { data: acc } = await (await import('../lib/supabase.js')).getSupabase()
          .from('email_accounts')
          .select('id, email, from_name, auth_type, gmail_client_id, gmail_client_secret, gmail_refresh_token, smtp_host, smtp_port, smtp_user, smtp_password, imap_host, imap_port, imap_user, imap_pass')
          .eq('id', pinnedId)
          .single();
        if (acc) {
          if (acc.auth_type === 'smtp' && acc.smtp_host && acc.smtp_user && acc.smtp_password) {
            senderAccount = {
              email: acc.email,
              fromName: acc.from_name,
              auth_type: 'smtp' as const,
              smtp_host: acc.smtp_host,
              smtp_port: acc.smtp_port ?? 587,
              smtp_user: acc.smtp_user,
              smtp_password: acc.smtp_password,
              imap_host: acc.imap_host ?? null,
              imap_port: acc.imap_port ?? null,
              imap_user: acc.imap_user ?? null,
              imap_pass: acc.imap_pass ?? null,
            };
            console.log(`[TestFlight] Using pinned SMTP sender: ${acc.email}`);
          } else if ((acc.auth_type === 'gmail_oauth' || acc.auth_type === 'app_password') && acc.gmail_client_id && acc.gmail_client_secret && acc.gmail_refresh_token) {
            const { createGmailClientFromCredentials } = await import('../services/gmail-client.js');
            senderAccount = {
              email: acc.email,
              fromName: acc.from_name,
              gmail: createGmailClientFromCredentials(acc.gmail_client_id, acc.gmail_client_secret, acc.gmail_refresh_token),
            };
            console.log(`[TestFlight] Using pinned Gmail sender: ${acc.email}`);
          } else if (acc.auth_type === 'ongage') {
            // Ongage transactional: connection is resolved per-sender from
            // ONGAGE_SENDERS (by email) inside the sender module.
            senderAccount = {
              email: acc.email,
              fromName: acc.from_name,
              auth_type: 'ongage' as const,
            };
            console.log(`[TestFlight] Using pinned Ongage sender: ${acc.email}`);
          } else {
            console.warn(`[TestFlight] Pinned account ${acc.email} (${acc.auth_type}) has incomplete credentials — falling back to env account`);
          }
        }
      } catch (e) {
        console.warn('[TestFlight] Could not load pinned account:', e instanceof Error ? e.message : e);
      }
    }

    const transformed = applyTestMode(
      { to: firstPendingLead.email_used as string, subject: renderedSubject, html: renderedHtml },
      true,
      testEmail,
    );

    const result = await sendEmail(
      transformed.to,
      transformed.subject,
      transformed.html,
      { screenshotPath: validScreenshotPath },
      senderAccount,
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
        sentFrom: senderAccount?.email || config.gmail.fromEmail || 'primary account',
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

  // Direct mode: set campaign to draft — DB scheduler checks status before each send
  try {
    await updateCampaign(campaignId, { status: 'draft' });
    res.json({ success: true, data: { message: 'Campaign cancelled — pending scheduled emails will not be sent.' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
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
  // Brevo uses EMAIL_MODE, not EMAIL_PLATFORM — handle it separately
  if (config.emailMode === 'brevo') {
    const hasKey = !!config.brevo.apiKey;
    res.json({
      success: true,
      data: {
        enabled: true,
        platform: 'Brevo',
        ok: hasKey,
        error: hasKey ? undefined : 'BREVO_API_KEY is not set',
      },
    });
    return;
  }

  if (!isPlatformEnabled()) {
    res.json({ success: true, data: { enabled: false, platform: config.emailMode === 'gmail' ? 'Gmail' : 'none' } });
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
    const { testMode, testEmail, limit, allowUnverified } = req.body;

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

    // Manual-only mode: verify all leads are manually-added (not scraped)
    if (config.manualLeadsOnly) {
      const hasScrapedLeads = campaignLeads.some((cl: { leads: Record<string, unknown> }) => {
        const tUrl = cl.leads?.trustpilot_url ? String(cl.leads.trustpilot_url) : '';
        return !tUrl.startsWith('manual:');
      });
      if (hasScrapedLeads) {
        res.status(400).json({ success: false, error: 'Manual-only mode: this campaign contains scraped leads. Remove them or disable MANUAL_LEADS_ONLY.' });
        return;
      }
    }

    // Deduplication: collect emails already successfully sent in ANY campaign
    const alreadySent = await getSentEmails();

    // Identify pending rows whose email_used is in the global sent-set.
    // These get a real terminal status so the UI pill is honest and we never
    // re-evaluate them at every send.
    const dedupSkipped = campaignLeads.filter(
      (cl: { id: string; email_used: string | null; status: string }) =>
        cl.status === 'pending' &&
        cl.email_used != null &&
        alreadySent.has(cl.email_used.toLowerCase()),
    );
    if (dedupSkipped.length > 0) {
      await markCampaignLeadsSkipped(
        dedupSkipped.map((cl: { id: string }) => cl.id),
        'already_contacted_in_another_campaign',
      );
    }

    // Filter to pending leads with valid, unsent emails
    const pendingLeads = campaignLeads.filter((cl: { email_used: string | null; status: string }) => {
      if (!cl.email_used || cl.status !== 'pending') return false;
      if (alreadySent.has(cl.email_used.toLowerCase())) return false;
      return true;
    });

    if (pendingLeads.length === 0) {
      res.status(400).json({ success: false, error: 'No pending leads with valid emails in this campaign' });
      return;
    }

    // ─── Send-gating: refuse to dispatch to addresses we can't stand behind ──
    // Two hard-blocked buckets, both of which used to reach the SMTP layer
    // and bounce:
    //   invalid    — a verifier proved the mailbox does not exist.
    //   unverified — no verifier ever looked at it. Sending blind is how a
    //                warmed domain gets torched; Operations hit exactly this
    //                on the Canada and Australia campaigns (2026-09-02).
    // catch-all and unknown still pass: the domain accepts everything or the
    // verifier was inconclusive, which is a judgement call, not a proven bad
    // address. The UI shows a caution chip for those.
    //
    // `allowUnverified: true` in the request body is the deliberate override
    // for an operator who has decided to send blind anyway. There is no
    // override for `invalid` — that one is never a judgement call.
    // Which verdict applies depends on which address this campaign actually
    // sends to. A discovery follow-up targets lead.discovered_email — the
    // address the recipient's own auto-reply handed us — so gating it on
    // verification_status (which describes primary_email) would block exactly
    // the leads that flow exists to rescue: the ones whose primary bounced.
    const isDiscoveryFollowup = campaign.campaign_type === 'discovery_followup';
    const verdictFor = (leads?: { verification_status?: string | null; discovered_email_status?: string | null }) =>
      (isDiscoveryFollowup ? leads?.discovered_email_status : leads?.verification_status) ?? null;

    const blockedRows = pendingLeads.filter((cl: {
      leads?: { verification_status?: string | null; discovered_email_status?: string | null };
    }) => {
      const v = verdictFor(cl.leads);
      if (v === 'invalid') return true;
      return v === null && !allowUnverified;
    });
    if (blockedRows.length > 0) {
      // Structured payload so the campaign UI can list the offending
      // recipients and offer remove / re-verify, instead of showing a dead-end
      // error string the operator can't act on.
      const blockedLeads = blockedRows.map((cl: {
        id: string;
        lead_id: string;
        email_used: string | null;
        leads?: {
          company_name?: string | null;
          verification_status?: string | null;
          discovered_email_status?: string | null;
        };
      }) => {
        const v = verdictFor(cl.leads);
        return {
          campaignLeadId: cl.id,
          leadId: cl.lead_id,
          email: cl.email_used,
          companyName: cl.leads?.company_name ?? null,
          verificationStatus: v,
          reason: v === 'invalid' ? 'invalid' : 'unverified',
        };
      });
      const invalidCount = blockedLeads.filter((b) => b.reason === 'invalid').length;
      const unverifiedCount = blockedLeads.length - invalidCount;
      const parts: string[] = [];
      if (invalidCount) parts.push(`${invalidCount} proven invalid`);
      if (unverifiedCount) parts.push(`${unverifiedCount} never verified`);
      res.status(400).json({
        success: false,
        error: `Send blocked: ${blockedLeads.length} recipient${blockedLeads.length === 1 ? '' : 's'} cannot be sent to (${parts.join(', ')}). Remove them or run verification, then send again.`,
        blockedLeads,
        blockedSummary: { invalid: invalidCount, unverified: unverifiedCount, total: blockedLeads.length },
      });
      return;
    }

    // ─── DNS gate: refuse if any pinned SMTP sender's domain is failing ──
    {
      const schedule = campaign.sending_schedule as Record<string, unknown> | null;
      const pinnedIds = (schedule?.senderAccountIds as string[] | undefined)
        ?? (schedule?.senderAccountId ? [schedule.senderAccountId as string] : []);
      if (pinnedIds.length > 0) {
        const gate = await gateSendersByDns(pinnedIds);
        if (!gate.ok) {
          res.status(400).json({ success: false, error: formatGateError(gate), dnsGate: gate });
          return;
        }
      }
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
          sending_schedule: campaign.sending_schedule ?? null,
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
        let validScreenshotPath: string | undefined;
        if (campaign.include_screenshot) {
          const leadScreenshotPath = lead.screenshot_path ? String(lead.screenshot_path) : '';
          if (leadScreenshotPath.startsWith('http')) {
            // Stored Supabase Storage URL — persistent and reliable
            validScreenshotPath = leadScreenshotPath;
          } else if (leadScreenshotPath) {
            // Local path — valid only in the same container that scraped it
            const localPath = path.resolve(screenshotsDir, path.basename(leadScreenshotPath));
            if (fs.existsSync(localPath)) {
              validScreenshotPath = localPath;
            }
            // Thum.io fallback removed — Cloud Run egress IPs get 403'd. Leads with
            // broken paths will send without a screenshot until they're re-scraped
            // or fix_screenshots.mjs is run to backfill Supabase Storage uploads.
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
      sendingSchedule: (!isTestMode && campaign.sending_schedule) ? campaign.sending_schedule : null,
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

// DELETE /api/campaigns/:id/leads — drop recipients from a campaign that has
// not gone out yet. This is the remediation half of the send gate: when a
// launch is refused because some recipients are undeliverable, the operator
// removes exactly those and launches, instead of rebuilding the campaign.
//
// Body: { campaignLeadIds?: string[], leadIds?: string[], blockedOnly?: true }
// `blockedOnly` is the one-click path — the server recomputes which pending
// recipients the send gate would refuse (invalid verdict, or never verified)
// and removes those, so the UI never has to keep a stale id list in sync.
// Only pending rows are ever removed; a sent row is a historical record.
router.delete('/:id/leads', async (req: Request, res: Response) => {
  try {
    const campaignId = param(req.params.id);
    const { campaignLeadIds, leadIds, blockedOnly } = req.body ?? {};

    let rowIds: string[] = Array.isArray(campaignLeadIds) ? campaignLeadIds : [];
    const explicitLeadIds: string[] = Array.isArray(leadIds) ? leadIds : [];

    if (blockedOnly) {
      // Recompute with the SAME rule the send gate uses, including which
      // address this campaign type actually targets — otherwise "remove the
      // blocked ones" could remove a different set than the one that was
      // blocked.
      const campaigns = await getCampaigns();
      const campaign = campaigns.find((c: { id: string }) => c.id === campaignId);
      const isDiscoveryFollowup = campaign?.campaign_type === 'discovery_followup';
      const campaignLeads = await getCampaignLeads(campaignId);
      rowIds = campaignLeads
        .filter((cl: {
          status: string;
          leads?: { verification_status?: string | null; discovered_email_status?: string | null };
        }) => {
          if (cl.status !== 'pending') return false;
          const v = (isDiscoveryFollowup ? cl.leads?.discovered_email_status : cl.leads?.verification_status) ?? null;
          return v === 'invalid' || v === null;
        })
        .map((cl: { id: string }) => cl.id);
    }

    if (rowIds.length === 0 && explicitLeadIds.length === 0) {
      res.json({ success: true, data: { removed: 0 } });
      return;
    }

    const removed = await removeCampaignLeads(campaignId, {
      campaignLeadIds: rowIds,
      leadIds: explicitLeadIds,
    });
    res.json({ success: true, data: { removed } });
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

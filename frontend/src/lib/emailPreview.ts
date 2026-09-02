/**
 * Server-rendered email preview.
 *
 * Standalone rather than hook-only so the preview modal can be dropped in
 * anywhere (wizard steps, campaign detail, the edit modal) without threading
 * a callback down through every intermediate component. useCampaigns wraps
 * this for callers that already hold the hook.
 */

import api from '../api/client';
import type { EmailPreview } from '../types/campaign';

export interface EmailPreviewInput {
  subject: string;
  body: string;
  /** Render against this specific lead. Wins over campaignId. */
  leadId?: string;
  /** Falls back to the campaign's first lead when no leadId is given. */
  campaignId?: string;
  includeScreenshot?: boolean;
  senderAccountId?: string;
}

export async function fetchEmailPreview(input: EmailPreviewInput): Promise<EmailPreview> {
  const res = await api.post('/campaigns/preview', input);
  return res.data.data as EmailPreview;
}

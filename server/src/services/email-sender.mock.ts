/**
 * Mock email sender — logs to console, updates DB status.
 * Replace with real Resend integration when API key is available.
 */

import { getSupabase } from '../lib/supabase.js';

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  console.log(`[MOCK] Would send email to: ${to}`);
  console.log(`  Subject: ${subject}`);
  console.log(`  Body preview: ${html.substring(0, 100)}...`);
  return true;
}

export async function sendCampaignEmails(
  campaignId: string,
  emails: Array<{ campaignLeadId: string; to: string; subject: string; html: string }>
): Promise<{ sent: number; failed: number }> {
  const supabase = getSupabase();
  let sent = 0;
  let failed = 0;

  for (const email of emails) {
    const success = await sendEmail(email.to, email.subject, email.html);
    if (success) {
      await supabase
        .from('campaign_leads')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', email.campaignLeadId);
      sent++;
    } else {
      failed++;
    }
  }

  // Update campaign totals
  await supabase
    .from('campaigns')
    .update({
      total_sent: sent,
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
    .eq('id', campaignId);

  console.log(`[MOCK] Campaign ${campaignId}: ${sent} sent, ${failed} failed`);
  return { sent, failed };
}

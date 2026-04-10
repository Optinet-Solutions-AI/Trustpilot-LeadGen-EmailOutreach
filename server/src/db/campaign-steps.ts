import { getSupabase } from '../lib/supabase.js';

export interface CampaignStepRow {
  id: string;
  campaign_id: string;
  step_number: number;
  delay_days: number;
  template_subject: string;
  template_body: string;
  created_at: string;
}

/** Get all steps for a campaign, ordered by step number. */
export async function getCampaignSteps(campaignId: string): Promise<CampaignStepRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('campaign_steps')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('step_number', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

/** Insert multiple steps for a campaign (bulk). */
export async function createCampaignSteps(
  campaignId: string,
  steps: Array<{ step_number: number; delay_days: number; template_subject: string; template_body: string }>
): Promise<CampaignStepRow[]> {
  const supabase = getSupabase();
  const rows = steps.map((s) => ({
    campaign_id: campaignId,
    step_number: s.step_number,
    delay_days: s.delay_days,
    template_subject: s.template_subject,
    template_body: s.template_body,
  }));
  const { data, error } = await supabase.from('campaign_steps').insert(rows).select();
  if (error) throw new Error(error.message);
  return data || [];
}

/** Delete all steps for a campaign. */
export async function deleteCampaignSteps(campaignId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('campaign_steps').delete().eq('campaign_id', campaignId);
  if (error) throw new Error(error.message);
}

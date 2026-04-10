-- Migration 007: Campaign Sequences (Follow-up Steps)
-- Adds multi-step email sequences to campaigns.
-- Each campaign can have N steps: step 1 = initial email, step 2+ = follow-ups.
-- For Instantly: all steps pushed as a native multi-step campaign.
-- For direct/Gmail: background scheduler sends follow-ups when due.

-- ── Campaign Steps table ────────────────────────────────────────────
-- Stores the email template for each step in a campaign sequence.
CREATE TABLE IF NOT EXISTS campaign_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_number   int  NOT NULL DEFAULT 1,
  delay_days    int  NOT NULL DEFAULT 0,          -- 0 for step 1 (immediate), 3/5/7 etc for follow-ups
  template_subject text NOT NULL,
  template_body    text NOT NULL,
  created_at    timestamptz DEFAULT now(),
  UNIQUE(campaign_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_cs_campaign ON campaign_steps(campaign_id);

-- ── Track sequence progress on campaign_leads ───────────────────────
-- Which step each lead is currently on, and when the next step is due.
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS current_step      int       DEFAULT 1;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS next_step_at      timestamptz;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS sequence_completed boolean   DEFAULT false;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS sequence_paused   boolean   DEFAULT false;

-- Index for the scheduler to quickly find leads with due follow-ups
CREATE INDEX IF NOT EXISTS idx_cl_next_step_due
  ON campaign_leads(next_step_at)
  WHERE next_step_at IS NOT NULL
    AND sequence_completed = false
    AND sequence_paused = false;

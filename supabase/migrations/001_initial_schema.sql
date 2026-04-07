-- ============================================================
-- Trustpilot Lead Gen & CRM — Initial Schema
-- Run this in Supabase SQL Editor to create all tables
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. LEADS — Core lead data from Trustpilot scraping
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name        text NOT NULL,
  trustpilot_url      text UNIQUE NOT NULL,
  website_url         text,
  trustpilot_email    text,
  website_email       text,
  primary_email       text,
  phone               text,
  country             text,
  category            text,
  star_rating         real,
  email_verified      boolean DEFAULT false,
  verification_status text DEFAULT 'unknown'
    CHECK (verification_status IN ('valid', 'invalid', 'catch-all', 'unknown')),
  outreach_status     text DEFAULT 'new'
    CHECK (outreach_status IN ('new', 'contacted', 'replied', 'converted', 'lost')),
  screenshot_path     text,
  lead_source         text DEFAULT 'trustpilot_scrape',
  scraped_at          timestamptz,
  contacted_at        timestamptz,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE INDEX idx_leads_outreach_status ON leads (outreach_status);
CREATE INDEX idx_leads_country_category ON leads (country, category);
CREATE INDEX idx_leads_star_rating ON leads (star_rating);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 2. CAMPAIGNS — Email campaign definitions + templates
-- ============================================================
CREATE TABLE IF NOT EXISTS campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  template_subject  text,
  template_body     text,
  status            text DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'completed')),
  include_screenshot boolean DEFAULT false,
  total_sent        int DEFAULT 0,
  total_opened      int DEFAULT 0,
  total_replied     int DEFAULT 0,
  total_bounced     int DEFAULT 0,
  sent_at           timestamptz,
  created_at        timestamptz DEFAULT now()
);

-- ============================================================
-- 3. CAMPAIGN_LEADS — Join table: per-lead email tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS campaign_leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  email_used    text,
  status        text DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'opened', 'replied', 'bounced')),
  sent_at       timestamptz,
  opened_at     timestamptz,
  replied_at    timestamptz,
  bounced_at    timestamptz,
  UNIQUE(campaign_id, lead_id)
);

CREATE INDEX idx_campaign_leads_campaign ON campaign_leads (campaign_id);
CREATE INDEX idx_campaign_leads_lead ON campaign_leads (lead_id);

-- ============================================================
-- 4. LEAD_NOTES — Activity log: notes, status changes, emails
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type        text NOT NULL
    CHECK (type IN ('note', 'status_change', 'email_sent', 'email_opened', 'email_replied', 'email_bounced', 'call', 'follow_up', 'verification')),
  content     text,
  metadata    jsonb DEFAULT '{}',
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX idx_lead_notes_lead ON lead_notes (lead_id);
CREATE INDEX idx_lead_notes_type ON lead_notes (type);

-- ============================================================
-- 5. SCRAPE_JOBS — Async scrape job tracking with progress
-- ============================================================
CREATE TABLE IF NOT EXISTS scrape_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country         text NOT NULL,
  category        text NOT NULL,
  min_rating      real DEFAULT 1.0,
  max_rating      real NOT NULL,
  enrich          boolean DEFAULT false,
  verify          boolean DEFAULT false,
  status          text DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  total_found     int DEFAULT 0,
  total_scraped   int DEFAULT 0,
  total_enriched  int DEFAULT 0,
  total_verified  int DEFAULT 0,
  error           text,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz DEFAULT now()
);

-- ============================================================
-- 6. FOLLOW_UPS — Scheduled follow-up reminders per lead
-- ============================================================
CREATE TABLE IF NOT EXISTS follow_ups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  due_date      timestamptz NOT NULL,
  note          text,
  completed     boolean DEFAULT false,
  completed_at  timestamptz,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX idx_follow_ups_lead ON follow_ups (lead_id);
CREATE INDEX idx_follow_ups_pending ON follow_ups (completed, due_date)
  WHERE completed = false;

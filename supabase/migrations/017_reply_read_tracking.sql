-- Migration 017: Track reply read state for in-app notifications.
--
-- campaign_leads.reply_read_at:
--   NULL       → reply unseen in the CRM (counts toward the notification badge)
--   timestamp  → user opened the thread in the Outreach Inbox
--
-- Populated NULL by the reply trackers (reply-tracker.ts + reply-tracker.imap.ts)
-- and cleared to NOW() by POST /api/inbox/mark-replies-read when the user opens
-- the message in the Inbox view.

ALTER TABLE campaign_leads
  ADD COLUMN IF NOT EXISTS reply_read_at timestamptz;

-- Partial index — the notification-count query only cares about unread replies
CREATE INDEX IF NOT EXISTS idx_cl_unread_replies
  ON campaign_leads (replied_at DESC)
  WHERE status = 'replied' AND reply_read_at IS NULL;

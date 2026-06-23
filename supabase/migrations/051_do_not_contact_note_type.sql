-- Migration 051: allow the 'marked_do_not_contact' activity-log note type
--
-- Migration 050 added the do-not-contact columns and the Inbox one-click
-- suppression endpoint (POST /api/inbox/do-not-contact), which writes a
-- lead_notes row of type 'marked_do_not_contact'. But the lead_notes.type
-- CHECK constraint (last set in migration 028) was never extended to allow
-- that value — so every suppression request threw 23514 on the note insert
-- and returned 500, AFTER the lead had already been flagged. The Inbox button
-- looked dead (the optimistic UI flip never ran) even though the lead was
-- actually suppressed in the DB.
--
-- Recreate the constraint with the new value appended. Keep every existing
-- value so prior note types stay valid.

ALTER TABLE lead_notes DROP CONSTRAINT IF EXISTS lead_notes_type_check;
ALTER TABLE lead_notes
  ADD CONSTRAINT lead_notes_type_check
  CHECK (type IN (
    'note', 'status_change',
    'email_sent', 'email_opened', 'email_replied', 'email_bounced',
    'call', 'follow_up', 'verification',
    -- from 028:
    'auto_reply_received',
    'auto_reply_no_contacts',
    'auto_reply_candidate',
    'discovered_contact_accepted',
    'discovered_contact_dismissed',
    'lead_spawned_from_discovery',
    -- new in 051:
    'marked_do_not_contact'         -- operator confirmed an opt-out reply from the Inbox
  ));

-- Verification (run manually after applying):
--   INSERT INTO lead_notes (lead_id, type, content)
--   SELECT id, 'marked_do_not_contact', 'constraint test' FROM leads LIMIT 1
--   RETURNING id;  -- should succeed; then DELETE it.

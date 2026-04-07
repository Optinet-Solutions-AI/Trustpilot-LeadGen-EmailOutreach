import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { verifyEmails } from '../services/email-verifier.mock.js';
import { createNote } from '../db/notes.js';

const router = Router();

// POST /api/verify — batch email verification
router.post('/', async (req: Request, res: Response) => {
  try {
    const { leadIds } = req.body;
    const supabase = getSupabase();

    // Fetch leads to verify
    let query = supabase.from('leads').select('id, primary_email, trustpilot_email, website_email');
    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      query = query.in('id', leadIds);
    } else {
      // Verify all unverified leads
      query = query.eq('email_verified', false);
    }

    const { data: leads, error } = await query;
    if (error) throw new Error(error.message);
    if (!leads || leads.length === 0) {
      res.json({ success: true, data: { verified: 0, invalid: 0, catchAll: 0 } });
      return;
    }

    // Collect unique emails
    const emailToLeadIds = new Map<string, string[]>();
    for (const lead of leads) {
      const email = lead.primary_email || lead.website_email || lead.trustpilot_email;
      if (email) {
        const existing = emailToLeadIds.get(email) || [];
        existing.push(lead.id);
        emailToLeadIds.set(email, existing);
      }
    }

    // Run verification
    const results = await verifyEmails([...emailToLeadIds.keys()]);

    // Update leads with verification results
    let verified = 0, invalid = 0, catchAll = 0;
    for (const result of results) {
      const leadIdsForEmail = emailToLeadIds.get(result.email) || [];
      const isVerified = result.status === 'valid';

      if (result.status === 'valid') verified++;
      else if (result.status === 'invalid') invalid++;
      else if (result.status === 'catch-all') catchAll++;

      for (const leadId of leadIdsForEmail) {
        await supabase.from('leads').update({
          email_verified: isVerified,
          verification_status: result.status,
        }).eq('id', leadId);

        await createNote(leadId, {
          type: 'verification',
          content: `Email ${result.email} verified: ${result.status}`,
          metadata: { email: result.email, status: result.status },
        });
      }
    }

    res.json({ success: true, data: { verified, invalid, catchAll } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

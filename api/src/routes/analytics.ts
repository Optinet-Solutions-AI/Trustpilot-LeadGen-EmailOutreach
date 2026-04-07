import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';

const router = Router();

// GET /api/analytics — dashboard aggregates
router.get('/', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();

    // Leads by status
    const { data: leads } = await supabase.from('leads').select('outreach_status');
    const leadsByStatus: Record<string, number> = { new: 0, contacted: 0, replied: 0, converted: 0, lost: 0 };
    for (const lead of leads || []) {
      const s = lead.outreach_status;
      if (s in leadsByStatus) leadsByStatus[s]++;
    }

    // Leads by country
    const { data: countryData } = await supabase.from('leads').select('country');
    const leadsByCountry: Record<string, number> = {};
    for (const lead of countryData || []) {
      const c = lead.country || 'Unknown';
      leadsByCountry[c] = (leadsByCountry[c] || 0) + 1;
    }

    // Leads by category
    const { data: catData } = await supabase.from('leads').select('category');
    const leadsByCategory: Record<string, number> = {};
    for (const lead of catData || []) {
      const c = lead.category || 'Unknown';
      leadsByCategory[c] = (leadsByCategory[c] || 0) + 1;
    }

    // Campaign stats
    const { data: campaigns } = await supabase
      .from('campaigns')
      .select('id, name, status, total_sent, total_opened, total_replied, total_bounced');

    // Recent scrape jobs
    const { data: scrapeJobs } = await supabase
      .from('scrape_jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    // Totals
    const totalLeads = (leads || []).length;
    const totalVerified = 0; // Could query separately if needed

    res.json({
      success: true,
      data: {
        totalLeads,
        totalVerified,
        leadsByStatus,
        leadsByCountry,
        leadsByCategory,
        campaigns: campaigns || [],
        recentScrapeJobs: scrapeJobs || [],
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

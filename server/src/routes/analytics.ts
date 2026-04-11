import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';

const router = Router();

// GET /api/analytics — dashboard aggregates
// Query param: ?period=7d|30d|all (default: all)
router.get('/', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const period = String(req.query.period || 'all');

    // Calculate cutoff date based on period
    let cutoffDate: string | null = null;
    if (period === '7d') {
      const d = new Date(); d.setDate(d.getDate() - 7);
      cutoffDate = d.toISOString();
    } else if (period === '30d') {
      const d = new Date(); d.setDate(d.getDate() - 30);
      cutoffDate = d.toISOString();
    }

    // Leads by status (all-time — status reflects current state, not creation date)
    const { data: leads } = await supabase.from('leads').select('outreach_status');
    const leadsByStatus: Record<string, number> = { new: 0, contacted: 0, replied: 0, converted: 0, lost: 0 };
    for (const lead of leads || []) {
      const s = lead.outreach_status;
      if (s in leadsByStatus) leadsByStatus[s]++;
    }

    // Leads by country (all-time)
    const { data: countryData } = await supabase.from('leads').select('country');
    const leadsByCountry: Record<string, number> = {};
    for (const lead of countryData || []) {
      const c = lead.country || 'Unknown';
      leadsByCountry[c] = (leadsByCountry[c] || 0) + 1;
    }

    // Leads by category (all-time)
    const { data: catData } = await supabase.from('leads').select('category');
    const leadsByCategory: Record<string, number> = {};
    for (const lead of catData || []) {
      const c = lead.category || 'Unknown';
      leadsByCategory[c] = (leadsByCategory[c] || 0) + 1;
    }

    // Campaign stats — filtered by period
    let campaignQuery = supabase
      .from('campaigns')
      .select('id, name, status, total_sent, total_opened, total_replied, total_bounced, created_at');
    if (cutoffDate) campaignQuery = campaignQuery.gte('created_at', cutoffDate);
    const { data: campaigns } = await campaignQuery;

    // Recent scrape jobs — filtered by period
    let scrapeQuery = supabase
      .from('scrape_jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);
    if (cutoffDate) scrapeQuery = scrapeQuery.gte('created_at', cutoffDate);
    const { data: scrapeJobs } = await scrapeQuery;

    const totalLeads = (leads || []).length;

    res.json({
      success: true,
      data: {
        totalLeads,
        totalVerified: 0,
        leadsByStatus,
        leadsByCountry,
        leadsByCategory,
        campaigns: campaigns || [],
        recentScrapeJobs: scrapeJobs || [],
        period,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

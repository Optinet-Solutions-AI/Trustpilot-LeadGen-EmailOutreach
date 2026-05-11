import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';

const router = Router();

// Bucket an ISO timestamp into a UTC YYYY-MM-DD key. UTC is intentional —
// daily reporting needs a stable bucket boundary; if we used local TZ here
// the same UTC timestamp could land in different days for different viewers.
function utcDayKey(iso: string): string {
  return iso.slice(0, 10);
}

// Inclusive iterator over YYYY-MM-DD between two UTC dates.
function* daysBetween(startUtc: Date, endUtc: Date): Generator<string> {
  const d = new Date(Date.UTC(startUtc.getUTCFullYear(), startUtc.getUTCMonth(), startUtc.getUTCDate()));
  const last = new Date(Date.UTC(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate()));
  while (d <= last) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

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

    // Campaign stats — filtered by period.
    // total_replied counts only human replies (campaign_leads.status='replied').
    // total_auto_replied (added in migration 028) tracks auto-routed contact
    // info separately so the dashboard reply-rate stays human-only.
    let campaignQuery = supabase
      .from('campaigns')
      .select('id, name, status, campaign_type, total_sent, total_opened, total_replied, total_auto_replied, total_bounced, created_at');
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

// GET /api/analytics/daily — per-day Sent + Replied counts for reporting.
// Query params (both optional, both YYYY-MM-DD):
//   start — first day (inclusive). Defaults to 30 days before end.
//   end   — last day (inclusive). Defaults to today (UTC).
// Buckets by campaign_leads.sent_at / replied_at in UTC; zero-fills empty days.
router.get('/daily', async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();

    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);

    const parseDate = (raw: unknown): Date | null => {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      const d = new Date(`${raw}T00:00:00.000Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const end = parseDate(req.query.end) ?? todayUtc;
    const defaultStart = new Date(end);
    defaultStart.setUTCDate(defaultStart.getUTCDate() - 29);
    let start = parseDate(req.query.start) ?? defaultStart;

    if (start > end) {
      return res.status(400).json({ success: false, error: 'start must be <= end' });
    }

    // Hard cap to 365 days so a runaway request can't pull years of rows
    const MAX_DAYS = 365;
    const spanDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (spanDays > MAX_DAYS) {
      start = new Date(end);
      start.setUTCDate(start.getUTCDate() - (MAX_DAYS - 1));
    }

    const startIso = start.toISOString();
    // End is inclusive — bump to start-of-next-day for the upper bound
    const endExclusive = new Date(end);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    const endExclusiveIso = endExclusive.toISOString();

    // Two parallel queries — we only need the timestamp columns, not the rows.
    const PAGE = 1000;
    const fetchAll = async (col: 'sent_at' | 'replied_at'): Promise<string[]> => {
      const all: string[] = [];
      let from = 0;
      for (;;) {
        const { data, error } = await supabase
          .from('campaign_leads')
          .select(col)
          .gte(col, startIso)
          .lt(col, endExclusiveIso)
          .not(col, 'is', null)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = (data ?? []) as Array<Record<string, string | null>>;
        for (const r of rows) {
          const v = r[col];
          if (typeof v === 'string') all.push(v);
        }
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      return all;
    };

    const [sentRows, repliedRows] = await Promise.all([fetchAll('sent_at'), fetchAll('replied_at')]);

    const sentByDay: Record<string, number> = {};
    const repliedByDay: Record<string, number> = {};
    for (const t of sentRows) {
      const k = utcDayKey(t);
      sentByDay[k] = (sentByDay[k] || 0) + 1;
    }
    for (const t of repliedRows) {
      const k = utcDayKey(t);
      repliedByDay[k] = (repliedByDay[k] || 0) + 1;
    }

    const days: Array<{ date: string; sent: number; replied: number }> = [];
    for (const date of daysBetween(start, end)) {
      days.push({
        date,
        sent: sentByDay[date] || 0,
        replied: repliedByDay[date] || 0,
      });
    }

    return res.json({
      success: true,
      data: {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
        days,
        totals: {
          sent: sentRows.length,
          replied: repliedRows.length,
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ success: false, error: message });
  }
});

export default router;

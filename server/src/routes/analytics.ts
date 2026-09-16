import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { selectAllRows } from '../lib/paginate.js';
import { summariseDailyActivity } from '../services/daily-activity.js';

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

    // The stored total_sent counters drift, in both directions: measured
    // 2026-09-16 they added to 4,864 against 3,765 emails actually sent — one
    // campaign's counter read 202 against 26 real sends, and three September
    // campaigns read 0 against 13-25. They are replaced here by a count of the
    // activity log, which records one row per real send and is never
    // overwritten, so the KPI card, the reply rate and the bounce rate all
    // agree with the Daily Activity chart instead of contradicting it.
    const sentNotes = await selectAllRows<{ metadata: { campaign_id?: string } | null }>(
      (from, to) => supabase
        .from('lead_notes')
        .select('metadata')
        .eq('type', 'email_sent')
        .order('id', { ascending: true })
        .range(from, to),
    );
    const realSentByCampaign = new Map<string, number>();
    for (const n of sentNotes) {
      const cid = n.metadata?.campaign_id;
      if (cid) realSentByCampaign.set(cid, (realSentByCampaign.get(cid) ?? 0) + 1);
    }
    const campaignsWithRealSends = (campaigns ?? []).map((c: Record<string, unknown>) => ({
      ...c,
      total_sent: realSentByCampaign.get(c.id as string) ?? 0,
    }));

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
        campaigns: campaignsWithRealSends,
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

    // Counted from the ACTIVITY LOG, one row per real send, rather than from
    // campaign_leads.sent_at — which holds a single timestamp per lead and is
    // overwritten by each later step in the sequence. Bucketing that column
    // erased a first email from its own day as soon as its follow-up went out:
    // measured 2026-09-16 over 24 Aug - 16 Sep, 483 emails had really gone out
    // and this chart showed 310, with five days reading zero that had each
    // really sent 21 to 30. See services/daily-activity.ts.
    const fetchEvents = async (noteType: 'email_sent' | 'email_replied'): Promise<string[]> =>
      (await selectAllRows<{ created_at: string }>((from, to) => supabase
        .from('lead_notes')
        .select('created_at')
        .eq('type', noteType)
        .gte('created_at', startIso)
        .lt('created_at', endExclusiveIso)
        .order('created_at', { ascending: true })
        .range(from, to)))
        .map((r) => r.created_at)
        .filter((t): t is string => typeof t === 'string');

    const [sentRows, repliedRows] = await Promise.all([
      fetchEvents('email_sent'),
      // 'email_replied' is human replies only; auto-responders are logged
      // separately as 'auto_reply_received' and deliberately not counted here.
      fetchEvents('email_replied'),
    ]);

    const { days } = summariseDailyActivity({
      sends: sentRows,
      replies: repliedRows,
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    });

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

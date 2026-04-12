import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { rateLimiter } from '../services/rate-limiter.js';

const router = Router();

// GET /api/email-accounts — list all configured accounts
// Always includes the env-var account, then any DB-stored accounts.
router.get('/', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: dbAccounts, error } = await supabase
      .from('email_accounts')
      .select('id, email, from_name, provider, status, smtp_host, smtp_port, created_at, notes')
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);

    const status = rateLimiter.getStatus();
    const warmup = rateLimiter.getWarmupStatus();

    // Build the env-var account (always present as primary)
    const envEmail = config.gmail.fromEmail || config.brevo?.fromEmail || '';
    const providerLabel =
      config.emailPlatform !== 'none' ? config.emailPlatform :
      config.emailMode === 'gmail' ? 'Gmail (Personal)' :
      config.emailMode === 'brevo' ? 'Brevo' : 'Mock';

    const envAccount = envEmail ? {
      id: '__env__',
      email: envEmail,
      from_name: config.gmail.fromName || 'OptiRate',
      provider: providerLabel,
      status: 'active',
      dailySent: status.dailyCount,
      dailyCap: status.dailyCap,
      hourlyCap: status.hourlyCap,
      warmupDay: warmup.day,
      warmupStatus: config.testMode.enabled
        ? `Day ${warmup.day} — Test Phase`
        : `Day ${warmup.day} — ${warmup.phase}`,
      source: 'env',
    } : null;

    // DB accounts (no live rate-limit stats — they're registered but not yet wired into the sender)
    const formattedDb = (dbAccounts ?? []).map((a) => ({
      id: a.id,
      email: a.email,
      from_name: a.from_name,
      provider: a.provider,
      status: a.status,
      smtp_host: a.smtp_host,
      smtp_port: a.smtp_port,
      notes: a.notes,
      dailySent: 0,
      dailyCap: 50,
      hourlyCap: 20,
      warmupDay: 1,
      warmupStatus: 'Registered — not yet active',
      source: 'db',
    }));

    res.json({
      success: true,
      data: {
        accounts: [...(envAccount ? [envAccount] : []), ...formattedDb],
        platform: config.emailPlatform,
        testMode: config.testMode.enabled,
        manualLeadsOnly: config.manualLeadsOnly,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/email-accounts — register a new account
router.post('/', async (req: Request, res: Response) => {
  try {
    const { email, fromName, provider, smtpHost, smtpPort, smtpUser, smtpPassword, notes } = req.body;

    if (!email || !fromName || !provider) {
      res.status(400).json({ success: false, error: 'email, fromName, and provider are required' });
      return;
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('email_accounts')
      .insert({
        email,
        from_name: fromName,
        provider,
        smtp_host: smtpHost || null,
        smtp_port: smtpPort || null,
        smtp_user: smtpUser || null,
        smtp_password: smtpPassword || null,
        notes: notes || null,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ success: false, error: 'An account with this email already exists' });
      } else {
        throw new Error(error.message);
      }
      return;
    }

    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// DELETE /api/email-accounts/:id — remove a DB account (cannot delete env account)
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (id === '__env__') {
      res.status(400).json({ success: false, error: 'Cannot delete the primary env-configured account' });
      return;
    }

    const supabase = getSupabase();
    const { error } = await supabase.from('email_accounts').delete().eq('id', id);
    if (error) throw new Error(error.message);

    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

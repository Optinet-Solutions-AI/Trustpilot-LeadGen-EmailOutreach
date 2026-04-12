import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { rateLimiter } from '../services/rate-limiter.js';

const router = Router();

// GET /api/email-accounts — list all configured accounts
router.get('/', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: dbAccounts, error } = await supabase
      .from('email_accounts')
      .select('id, email, from_name, provider, status, smtp_host, smtp_port, smtp_secure, auth_type, notes, created_at')
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);

    const status = rateLimiter.getStatus();
    const warmup = rateLimiter.getWarmupStatus();

    const envEmail = config.gmail.fromEmail || config.brevo?.fromEmail || '';
    const providerLabel =
      config.emailPlatform !== 'none' ? config.emailPlatform :
      config.emailMode === 'gmail' ? 'Gmail (OAuth2)' :
      config.emailMode === 'brevo' ? 'Brevo' : 'Mock';

    const envAccount = envEmail ? {
      id: '__env__',
      email: envEmail,
      from_name: config.gmail.fromName || 'OptiRate',
      provider: providerLabel,
      auth_type: 'gmail_oauth',
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

    const formattedDb = (dbAccounts ?? []).map((a) => ({
      id: a.id,
      email: a.email,
      from_name: a.from_name,
      provider: a.provider,
      auth_type: a.auth_type,
      status: a.status,
      smtp_host: a.smtp_host,
      smtp_port: a.smtp_port,
      smtp_secure: a.smtp_secure,
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

// POST /api/email-accounts/test — verify credentials without saving
router.post('/test', async (req: Request, res: Response) => {
  const {
    authType, email,
    gmailClientId, gmailClientSecret, gmailRefreshToken,
    appPassword,
    smtpHost, smtpPort, smtpUser, smtpPassword, smtpSecure,
  } = req.body;

  try {
    if (authType === 'gmail_oauth') {
      if (!gmailClientId || !gmailClientSecret || !gmailRefreshToken) {
        res.status(400).json({ success: false, error: 'Client ID, Client Secret, and Refresh Token are all required.' });
        return;
      }
      const { google } = await import('googleapis');
      const oauth2Client = new google.auth.OAuth2(gmailClientId, gmailClientSecret);
      oauth2Client.setCredentials({ refresh_token: gmailRefreshToken });
      const tokenRes = await oauth2Client.getAccessToken();
      if (!tokenRes.token) throw new Error('Could not obtain access token — check Client ID, Secret, and Refresh Token.');
      res.json({ success: true, data: { message: 'Gmail OAuth2 connected successfully ✓' } });

    } else if (authType === 'app_password') {
      if (!email || !appPassword) {
        res.status(400).json({ success: false, error: 'Email and App Password are required.' });
        return;
      }
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: email, pass: appPassword },
      });
      await transporter.verify();
      res.json({ success: true, data: { message: 'Gmail App Password connection verified ✓' } });

    } else if (authType === 'smtp') {
      if (!smtpHost || !smtpUser || !smtpPassword) {
        res.status(400).json({ success: false, error: 'Host, username, and password are required for SMTP.' });
        return;
      }
      const port = parseInt(smtpPort) || 587;
      const secure = smtpSecure === 'ssl';
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port,
        secure,
        ...(smtpSecure === 'none' ? { ignoreTLS: true } : {}),
        auth: { user: smtpUser, pass: smtpPassword },
      });
      await transporter.verify();
      res.json({ success: true, data: { message: `SMTP connection to ${smtpHost}:${port} verified ✓` } });

    } else if (authType === 'instantly') {
      if (!email) {
        res.status(400).json({ success: false, error: 'Email address is required.' });
        return;
      }
      res.json({ success: true, data: { message: 'Account registered for Instantly.ai management ✓' } });

    } else {
      res.status(400).json({ success: false, error: 'Unknown auth type.' });
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Strip verbose nodemailer internals
    const message = raw.split('\n')[0].replace(/\s*\[.*?\]/g, '');
    res.status(400).json({ success: false, error: `Connection failed: ${message}` });
  }
});

// POST /api/email-accounts — register a new account
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      email, fromName, provider, authType,
      gmailClientId, gmailClientSecret, gmailRefreshToken,
      appPassword,
      smtpHost, smtpPort, smtpUser, smtpPassword, smtpSecure,
      notes,
    } = req.body;

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
        auth_type: authType || 'smtp',
        smtp_host: smtpHost || null,
        smtp_port: smtpPort || null,
        smtp_user: smtpUser || null,
        smtp_password: smtpPassword || null,
        smtp_secure: smtpSecure || 'tls',
        app_password: appPassword || null,
        gmail_client_id: gmailClientId || null,
        gmail_client_secret: gmailClientSecret || null,
        gmail_refresh_token: gmailRefreshToken || null,
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

// DELETE /api/email-accounts/:id — remove a DB account
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

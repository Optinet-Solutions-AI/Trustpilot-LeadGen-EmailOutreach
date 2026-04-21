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
      warmupStatus: 'Active sender',
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

// POST /api/email-accounts/oauth/exchange — exchange Google auth code for refresh token
// Called by the frontend /oauth/callback page after Google redirects back
router.post('/oauth/exchange', async (req: Request, res: Response) => {
  const { code, clientId, clientSecret, redirectUri } = req.body;
  if (!code || !clientId || !clientSecret || !redirectUri) {
    res.status(400).json({ success: false, error: 'code, clientId, clientSecret, and redirectUri are required' });
    return;
  }
  try {
    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code as string);

    if (!tokens.refresh_token) {
      res.status(400).json({
        success: false,
        error: 'Google did not return a refresh token. Go to myaccount.google.com/permissions, revoke access for this app, then try again.',
      });
      return;
    }

    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    res.json({ success: true, data: { refreshToken: tokens.refresh_token, email: userInfo.email } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: `Token exchange failed: ${message}` });
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
        res.status(400).json({ success: false, error: 'Client ID, Client Secret, and Refresh Token are required. Complete the Sign in with Google flow first.' });
        return;
      }
      const { google } = await import('googleapis');
      const oauth2Client = new google.auth.OAuth2(gmailClientId, gmailClientSecret);
      oauth2Client.setCredentials({ refresh_token: gmailRefreshToken });
      const tokenRes = await oauth2Client.getAccessToken();
      if (!tokenRes.token) throw new Error('Could not obtain access token — check credentials.');
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
        auth: { user: email, pass: appPassword.replace(/\s/g, '') },
      });
      await transporter.verify();
      res.json({ success: true, data: { message: 'Gmail App Password connection verified ✓' } });

    } else if (authType === 'smtp') {
      if (!smtpHost || !smtpUser || !smtpPassword) {
        res.status(400).json({ success: false, error: 'Host, username, and password are required.' });
        return;
      }
      const port = parseInt(smtpPort) || 587;
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port,
        secure: smtpSecure === 'ssl',
        ...(smtpSecure === 'none' ? { ignoreTLS: true } : {}),
        auth: { user: smtpUser, pass: smtpPassword },
      });
      await transporter.verify();
      res.json({ success: true, data: { message: `SMTP verified: ${smtpHost}:${port} ✓` } });

    } else if (authType === 'instantly') {
      if (!email) { res.status(400).json({ success: false, error: 'Email address is required.' }); return; }
      res.json({ success: true, data: { message: 'Account registered for Instantly.ai ✓' } });

    } else {
      res.status(400).json({ success: false, error: 'Unknown auth type.' });
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.split('\n')[0].replace(/\s*\[.*?\]/g, '');
    res.status(400).json({ success: false, error: `Connection failed: ${message}` });
  }
});

// POST /api/email-accounts — save a new account
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      email, fromName, provider, authType,
      gmailClientId, gmailClientSecret, gmailRefreshToken,
      appPassword,
      smtpHost, smtpPort, smtpUser, smtpPassword, smtpSecure,
      imapHost, imapPort,
      notes,
    } = req.body;

    if (!email || !fromName || !provider) {
      res.status(400).json({ success: false, error: 'email, fromName, and provider are required' });
      return;
    }

    const isSmtp = authType === 'smtp';

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('email_accounts')
      .insert({
        email,
        from_name: fromName,
        provider,
        auth_type: authType || 'smtp',
        email_provider: isSmtp ? 'smtp' : 'gmail',
        smtp_host: smtpHost || null,
        smtp_port: smtpPort || null,
        smtp_user: smtpUser || null,
        smtp_password: smtpPassword || null,
        smtp_secure: smtpSecure || 'tls',
        imap_host: imapHost || null,
        imap_port: imapPort || null,
        imap_user: isSmtp ? (smtpUser || null) : null,
        imap_pass: isSmtp ? (smtpPassword || null) : null,
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

// POST /api/email-accounts/dreamhost — test + save a DreamHost SMTP/IMAP account
router.post('/dreamhost', async (req: Request, res: Response) => {
  const { email, fromName, password, smtpHost, smtpPort, imapHost, imapPort } = req.body;

  if (!email || !password || !smtpHost || !smtpPort || !imapHost || !imapPort) {
    res.status(400).json({ success: false, error: 'email, password, smtpHost, smtpPort, imapHost, and imapPort are required' });
    return;
  }

  const parsedSmtpPort = parseInt(smtpPort, 10);
  const parsedImapPort = parseInt(imapPort, 10);

  // 1. Test SMTP connection
  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parsedSmtpPort,
      secure: parsedSmtpPort === 465,
      auth: { user: email, pass: password },
    });
    await transporter.verify();
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    res.status(400).json({ success: false, error: `SMTP connection failed: ${msg}` });
    return;
  }

  // 2. Test IMAP connection (soft — warn but don't block save if IMAP is unreachable)
  let imapWarning: string | null = null;
  try {
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host: imapHost,
      port: parsedImapPort,
      secure: true,
      auth: { user: email, pass: password },
      logger: false,
      connectionTimeout: 10000,
    });
    await Promise.race([
      client.connect().then(() => client.logout()),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('IMAP connection timed out after 10s')), 10000)),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    imapWarning = `IMAP unavailable (${msg}) — reply tracking disabled. SMTP is working.`;
    console.warn(`[DreamHost] IMAP soft-fail for ${email}:`, msg);
  }

  // 3. Save to DB
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('email_accounts')
      .insert({
        email,
        from_name: fromName || email,
        provider: 'DreamHost (SMTP)',
        auth_type: 'smtp',
        email_provider: 'smtp',
        smtp_host: smtpHost,
        smtp_port: parsedSmtpPort,
        smtp_user: email,
        smtp_password: password,
        smtp_secure: parsedSmtpPort === 465 ? 'ssl' : 'tls',
        imap_host: imapHost,
        imap_port: parsedImapPort,
        imap_user: email,
        imap_pass: password,
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

    res.json({ success: true, data, warning: imapWarning || undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/email-accounts/bluehost — test + save a Bluehost Professional Email (Titan) account
router.post('/bluehost', async (req: Request, res: Response) => {
  const {
    email,
    fromName,
    password,
    smtpHost = 'smtp.titan.email',
    smtpPort = '465',
    imapHost = 'imap.titan.email',
    imapPort = '993',
  } = req.body;

  if (!email || !password) {
    res.status(400).json({ success: false, error: 'email and password are required' });
    return;
  }

  const parsedSmtpPort = parseInt(String(smtpPort), 10);
  const parsedImapPort = parseInt(String(imapPort), 10);

  // 1. Test SMTP connection
  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parsedSmtpPort,
      secure: parsedSmtpPort === 465,
      auth: { user: email, pass: password },
    });
    await transporter.verify();
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    res.status(400).json({ success: false, error: `SMTP connection failed: ${msg}` });
    return;
  }

  // 2. Test IMAP connection (soft-fail — warn but don't block save)
  let imapWarning: string | null = null;
  try {
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host: imapHost,
      port: parsedImapPort,
      secure: true,
      auth: { user: email, pass: password },
      logger: false,
      connectionTimeout: 10000,
    });
    await Promise.race([
      client.connect().then(() => client.logout()),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('IMAP connection timed out after 10s')), 10000)),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    imapWarning = `IMAP unavailable (${msg}) — reply tracking disabled. SMTP is working.`;
    console.warn(`[Bluehost] IMAP soft-fail for ${email}:`, msg);
  }

  // 3. Save to DB
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('email_accounts')
      .insert({
        email,
        from_name: fromName || email,
        provider: 'Bluehost (Titan SMTP)',
        auth_type: 'smtp',
        email_provider: 'smtp',
        smtp_host: smtpHost,
        smtp_port: parsedSmtpPort,
        smtp_user: email,
        smtp_password: password,
        smtp_secure: parsedSmtpPort === 465 ? 'ssl' : 'tls',
        imap_host: imapHost,
        imap_port: parsedImapPort,
        imap_user: email,
        imap_pass: password,
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

    res.json({ success: true, data, warning: imapWarning || undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// DELETE /api/email-accounts/:id
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

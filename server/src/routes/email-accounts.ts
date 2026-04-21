import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { verifyDomainDNS } from '../services/dns-checker.js';

const router = Router();

const DNS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

// GET /api/email-accounts — list all configured accounts with real per-account stats
router.get('/', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    // Pull all columns — some may not exist if migration 016 hasn't been applied yet.
    // We select('*') so missing columns just return undefined instead of failing the query.
    const { data: dbAccounts, error } = await supabase
      .from('email_accounts')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);

    const status = rateLimiter.getStatus();
    const warmup = rateLimiter.getWarmupStatus();

    const envEmail = config.gmail.fromEmail || config.brevo?.fromEmail || '';
    const providerLabel =
      config.emailPlatform !== 'none' ? config.emailPlatform :
      config.emailMode === 'gmail' ? 'Gmail (OAuth2)' :
      config.emailMode === 'brevo' ? 'Brevo' : 'Mock';

    // ── Per-account dailySent: count sends per sender_email for the last 24h ─────
    const nowIso = new Date().toISOString();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since1h  = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sentCounts: Record<string, { daily: number; hourly: number }> = {};
    try {
      const { data: sentRows } = await supabase
        .from('campaign_leads')
        .select('sender_email, sent_at')
        .eq('status', 'sent')
        .gte('sent_at', since24h);
      for (const row of sentRows ?? []) {
        const key = (row as { sender_email?: string }).sender_email?.toLowerCase();
        const sentAt = (row as { sent_at?: string }).sent_at;
        if (!key || !sentAt) continue;
        if (!sentCounts[key]) sentCounts[key] = { daily: 0, hourly: 0 };
        sentCounts[key].daily += 1;
        if (sentAt >= since1h) sentCounts[key].hourly += 1;
      }
    } catch {
      // sender_email column missing or query failed — leave counts empty
    }

    const envAccount = envEmail ? {
      id: '__env__',
      email: envEmail,
      from_name: config.gmail.fromName || 'OptiRate',
      provider: providerLabel,
      auth_type: 'gmail_oauth',
      status: 'active',
      dailySent: sentCounts[envEmail.toLowerCase()]?.daily ?? status.dailyCount,
      hourlySent: sentCounts[envEmail.toLowerCase()]?.hourly ?? status.hourlyCount,
      dailyCap: status.dailyCap,
      hourlyCap: status.hourlyCap,
      warmupDay: warmup.day,
      warmupStatus: config.testMode.enabled
        ? `Day ${warmup.day} — Test Phase`
        : `Day ${warmup.day} — ${warmup.phase}`,
      dns: null as null | { mx: boolean; spf: boolean; dmarc: boolean; checkedAt: string },
      source: 'env',
    } : null;

    // ── DNS: refresh stale per-account caches in the background ─────────────────
    const dnsTasks: Promise<void>[] = [];
    for (const a of (dbAccounts ?? []) as Array<Record<string, unknown>>) {
      if (a.auth_type !== 'smtp') continue;
      const checkedAt = a.dns_checked_at as string | null | undefined;
      const stale = !checkedAt || Date.now() - new Date(checkedAt).getTime() > DNS_CACHE_TTL_MS;
      if (!stale) continue;
      const domain = domainOf(String(a.email));
      if (!domain) continue;
      dnsTasks.push((async () => {
        try {
          const result = await verifyDomainDNS(domain);
          await supabase.from('email_accounts').update({
            dns_mx: result.mx,
            dns_spf: result.spf,
            dns_dmarc: result.dmarc,
            dns_checked_at: nowIso,
          }).eq('id', a.id as string);
          a.dns_mx = result.mx;
          a.dns_spf = result.spf;
          a.dns_dmarc = result.dmarc;
          a.dns_checked_at = nowIso;
        } catch {
          // Column missing (pre-migration) or DNS failure — ignore
        }
      })());
    }
    // Wait for DNS refreshes (usually <500ms; bounded by Promise.all)
    await Promise.all(dnsTasks).catch(() => {});

    const formattedDb = (dbAccounts ?? []).map((a: Record<string, unknown>) => {
      const emailKey = String(a.email).toLowerCase();
      const rawDailyCap  = a.daily_cap  as number | null | undefined;
      const rawHourlyCap = a.hourly_cap as number | null | undefined;
      const dailyCap  = rawDailyCap  != null ? rawDailyCap  : config.rateLimits.dailyCap;
      const hourlyCap = rawHourlyCap != null ? rawHourlyCap : config.rateLimits.hourlyCap;
      const counts = sentCounts[emailKey] ?? { daily: 0, hourly: 0 };

      const hasDnsFields = a.dns_checked_at != null;
      const dns = hasDnsFields ? {
        mx:        !!a.dns_mx,
        spf:       !!a.dns_spf,
        dmarc:     !!a.dns_dmarc,
        checkedAt: String(a.dns_checked_at),
      } : null;

      return {
        id:          a.id,
        email:       a.email,
        from_name:   a.from_name,
        provider:    a.provider,
        auth_type:   a.auth_type,
        status:      a.status,
        smtp_host:   a.smtp_host,
        smtp_port:   a.smtp_port,
        smtp_secure: a.smtp_secure,
        notes:       a.notes,
        dailySent:   counts.daily,
        hourlySent:  counts.hourly,
        dailyCap,
        hourlyCap,
        warmupDay:    1,
        warmupStatus: 'Active sender',
        dns,
        source: 'db',
      };
    });

    res.json({
      success: true,
      data: {
        accounts: [...(envAccount ? [envAccount] : []), ...formattedDb],
        platform: config.emailPlatform,
        testMode: config.testMode.enabled,
        manualLeadsOnly: config.manualLeadsOnly,
        defaults: {
          dailyCap:  config.rateLimits.dailyCap,
          hourlyCap: config.rateLimits.hourlyCap,
        },
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
      dailyCap, hourlyCap,
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
        daily_cap:  dailyCap  != null ? Number(dailyCap)  : null,
        hourly_cap: hourlyCap != null ? Number(hourlyCap) : null,
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

// PATCH /api/email-accounts/:id — update editable fields (caps, from_name, status)
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (id === '__env__') {
      res.status(400).json({ success: false, error: 'The env-configured account is read-only' });
      return;
    }
    const { dailyCap, hourlyCap, fromName, status, notes } = req.body;

    const patch: Record<string, unknown> = {};
    if (dailyCap  !== undefined) patch.daily_cap  = dailyCap  === null || dailyCap  === '' ? null : Number(dailyCap);
    if (hourlyCap !== undefined) patch.hourly_cap = hourlyCap === null || hourlyCap === '' ? null : Number(hourlyCap);
    if (fromName  !== undefined) patch.from_name  = fromName;
    if (status    !== undefined) patch.status     = status;
    if (notes     !== undefined) patch.notes      = notes;

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ success: false, error: 'No updatable fields provided' });
      return;
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('email_accounts')
      .update(patch)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/email-accounts/:id/dns-refresh — re-run DNS checks for this account's domain
router.post('/:id/dns-refresh', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (id === '__env__') {
      res.status(400).json({ success: false, error: 'DNS refresh is only supported for database accounts' });
      return;
    }
    const supabase = getSupabase();
    const { data: account, error: fetchErr } = await supabase
      .from('email_accounts')
      .select('email')
      .eq('id', id)
      .single();
    if (fetchErr || !account) {
      res.status(404).json({ success: false, error: 'Account not found' });
      return;
    }
    const domain = String(account.email).split('@')[1]?.toLowerCase();
    if (!domain) {
      res.status(400).json({ success: false, error: 'Could not parse domain from email' });
      return;
    }
    const result = await verifyDomainDNS(domain);
    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from('email_accounts')
      .update({
        dns_mx: result.mx,
        dns_spf: result.spf,
        dns_dmarc: result.dmarc,
        dns_checked_at: nowIso,
      })
      .eq('id', id);
    if (updErr) throw new Error(updErr.message);

    res.json({
      success: true,
      data: { domain, mx: result.mx, spf: result.spf, dmarc: result.dmarc, checkedAt: nowIso },
    });
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

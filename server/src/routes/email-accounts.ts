import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { randomBytes } from 'crypto';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { rateLimiter } from '../services/rate-limiter.js';

const router = Router();

// ── In-memory OAuth state store (clientId + clientSecret keyed by random state token) ──
interface OAuthState { clientId: string; clientSecret: string; createdAt: number }
const oauthStates = new Map<string, OAuthState>();
// Expire entries after 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of oauthStates) if (v.createdAt < cutoff) oauthStates.delete(k);
}, 60_000);

// GET /api/email-accounts/oauth/start?clientId=...&clientSecret=...
// Generates a Google OAuth consent URL and redirects the popup there.
router.get('/oauth/start', (req: Request, res: Response) => {
  const { clientId, clientSecret } = req.query as Record<string, string>;
  if (!clientId || !clientSecret) {
    res.status(400).send('clientId and clientSecret are required');
    return;
  }
  const state = randomBytes(16).toString('hex');
  oauthStates.set(state, { clientId, clientSecret, createdAt: Date.now() });

  const redirectUri = `${req.protocol}://${req.get('host')}/api/email-accounts/oauth/callback`;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',          // force refresh_token every time
    scope: ['https://mail.google.com/'],
    state,
  });
  res.redirect(url);
});

// GET /api/email-accounts/oauth/callback  — Google redirects here after user approves
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    res.send(popupHtml({ ok: false, message: `Google denied access: ${error}` }));
    return;
  }
  if (!code || !state || !oauthStates.has(state)) {
    res.send(popupHtml({ ok: false, message: 'Invalid or expired OAuth state. Please try again.' }));
    return;
  }

  const { clientId, clientSecret } = oauthStates.get(state)!;
  oauthStates.delete(state);

  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/api/email-accounts/oauth/callback`;
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      res.send(popupHtml({ ok: false, message: 'No refresh token returned. Revoke app access at myaccount.google.com/permissions and try again.' }));
      return;
    }

    // Get user's email via People API
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    res.send(popupHtml({
      ok: true,
      refreshToken: tokens.refresh_token,
      email: userInfo.email ?? '',
      message: `Connected as ${userInfo.email}`,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.send(popupHtml({ ok: false, message: `Token exchange failed: ${msg}` }));
  }
});

/** Returns a minimal HTML page that posts a message to the opener and closes itself. */
function popupHtml(payload: Record<string, unknown>): string {
  return `<!DOCTYPE html><html><body>
<script>
  try {
    window.opener.postMessage(${JSON.stringify({ type: 'gmail-oauth', ...payload })}, '*');
  } catch(e) {}
  window.close();
</script>
<p style="font-family:sans-serif;text-align:center;padding:40px">
  ${payload.ok ? '✅ ' + payload.message : '❌ ' + payload.message}<br>
  <small>You can close this window.</small>
</p>
</body></html>`;
}

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

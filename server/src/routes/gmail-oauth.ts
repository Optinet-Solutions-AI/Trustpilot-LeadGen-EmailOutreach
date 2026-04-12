/**
 * Gmail OAuth2 flow — mounted BEFORE authMiddleware so Google can redirect
 * to /api/email-accounts/oauth/callback without an API key.
 *
 * Routes (relative to /api/email-accounts):
 *   GET /oauth/start?clientId=...&clientSecret=...  → redirect to Google consent
 *   GET /oauth/callback?code=...&state=...          → exchange code, postMessage to opener
 */

import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { randomBytes } from 'crypto';

export const router = Router();

// ── In-memory state store ─────────────────────────────────────────────────────
interface OAuthState { clientId: string; clientSecret: string; createdAt: number }
const oauthStates = new Map<string, OAuthState>();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of oauthStates) if (v.createdAt < cutoff) oauthStates.delete(k);
}, 60_000);

// GET /api/email-accounts/oauth/start
router.get('/oauth/start', (req: Request, res: Response) => {
  const { clientId, clientSecret } = req.query as Record<string, string>;
  if (!clientId || !clientSecret) {
    res.status(400).send('clientId and clientSecret are required');
    return;
  }

  const state = randomBytes(16).toString('hex');
  oauthStates.set(state, { clientId, clientSecret, createdAt: Date.now() });

  // Build redirect URI from the incoming request so it works in both dev and Cloud Run
  const redirectUri = buildRedirectUri(req);
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',   // always return refresh_token
    scope: ['https://mail.google.com/', 'https://www.googleapis.com/auth/userinfo.email'],
    state,
  });
  res.redirect(url);
});

// GET /api/email-accounts/oauth/callback
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    res.send(popupHtml({ ok: false, message: `Google denied access: ${error}` }));
    return;
  }
  if (!code || !state || !oauthStates.has(state)) {
    res.send(popupHtml({ ok: false, message: 'Invalid or expired state. Please close this window and try again.' }));
    return;
  }

  const { clientId, clientSecret } = oauthStates.get(state)!;
  oauthStates.delete(state);

  try {
    const redirectUri = buildRedirectUri(req);
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      res.send(popupHtml({
        ok: false,
        message: 'Google did not return a refresh token. Go to myaccount.google.com/permissions, revoke access for this app, then try again.',
      }));
      return;
    }

    // Fetch the Gmail address that just authenticated
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRedirectUri(req: Request): string {
  // Cloud Run sits behind a load balancer that terminates TLS — use x-forwarded-proto
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host  = req.headers['x-forwarded-host']  ?? req.get('host');
  return `${proto}://${host}/api/email-accounts/oauth/callback`;
}

function popupHtml(payload: Record<string, unknown>): string {
  return `<!DOCTYPE html><html><head><title>Gmail OAuth</title></head><body
    style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8f9fa">
<div style="text-align:center;padding:40px;background:white;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px">
  <div style="font-size:48px;margin-bottom:16px">${payload.ok ? '✅' : '❌'}</div>
  <p style="font-size:15px;color:${payload.ok ? '#006630' : '#b0004a'};font-weight:600;margin:0 0 8px">
    ${payload.message}
  </p>
  <p style="font-size:12px;color:#888;margin:0">You can close this window.</p>
</div>
<script>
  try { window.opener.postMessage(${JSON.stringify({ type: 'gmail-oauth', ...payload })}, '*'); } catch(e) {}
  setTimeout(() => window.close(), 1500);
</script>
</body></html>`;
}

export default router;

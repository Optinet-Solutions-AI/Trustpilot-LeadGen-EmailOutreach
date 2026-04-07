/**
 * Gmail API client singleton.
 * Uses OAuth2 with a long-lived refresh token stored in .env
 */

import { google } from 'googleapis';
import { config } from '../config.js';

let gmailInstance: ReturnType<typeof google.gmail> | null = null;

export function getGmailClient() {
  if (gmailInstance) return gmailInstance;

  if (!config.gmail.clientId || !config.gmail.clientSecret || !config.gmail.refreshToken) {
    throw new Error(
      'Gmail credentials missing. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env. ' +
      'Run `node scripts/gmail-auth-setup.js` to generate a refresh token.'
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
  );

  oauth2Client.setCredentials({
    refresh_token: config.gmail.refreshToken,
  });

  // Auto-refresh access token on expiry
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      console.log('[Gmail] New refresh token received — update GOOGLE_REFRESH_TOKEN in .env');
    }
  });

  gmailInstance = google.gmail({ version: 'v1', auth: oauth2Client });
  return gmailInstance;
}

/**
 * Gmail API client factory.
 * - getGmailClient()                          → primary env-var account (singleton)
 * - createGmailClientFromCredentials(...)     → any additional account stored in DB
 */

import { google } from 'googleapis';
import { config } from '../config.js';

let gmailInstance: ReturnType<typeof google.gmail> | null = null;

export function getGmailClient() {
  if (gmailInstance) return gmailInstance;

  if (!config.gmail.clientId || !config.gmail.clientSecret || !config.gmail.refreshToken) {
    throw new Error(
      'Gmail credentials missing. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env.'
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
  );
  oauth2Client.setCredentials({ refresh_token: config.gmail.refreshToken });
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) console.log('[Gmail] New refresh token received — update GOOGLE_REFRESH_TOKEN in .env');
  });

  gmailInstance = google.gmail({ version: 'v1', auth: oauth2Client });
  return gmailInstance;
}

/** Create a Gmail client from credentials stored in the email_accounts DB table. */
export function createGmailClientFromCredentials(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): ReturnType<typeof google.gmail> {
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

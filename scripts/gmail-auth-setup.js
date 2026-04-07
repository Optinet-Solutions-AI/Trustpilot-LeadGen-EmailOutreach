/**
 * Gmail OAuth2 Setup Script
 * Run with: node scripts/gmail-auth-setup.js
 *
 * This generates a GOOGLE_REFRESH_TOKEN for use in .env
 * Prerequisites:
 *   1. Create a Google Cloud project at https://console.cloud.google.com
 *   2. Enable Gmail API (APIs & Services → Library → Gmail API)
 *   3. Create OAuth 2.0 credentials (APIs & Services → Credentials → Create Credentials → OAuth client ID)
 *      - Application type: Web application
 *      - Authorized redirect URI: http://localhost:3333/callback
 *   4. Copy your Client ID and Client Secret below or set them in .env
 */

const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');

// Load .env from project root
try {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (_) {}

const readline = require('readline');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

const REDIRECT_URI = 'http://localhost:3333/callback';
const PORT = 3333;

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('\n=== Gmail OAuth2 Setup ===\n');
  console.log('This script will open a browser window to authorize access to your Gmail account.');
  console.log('A refresh token will be printed at the end — paste it into your .env file.\n');

  let clientId = process.env.GOOGLE_CLIENT_ID || '';
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';

  if (!clientId) {
    clientId = await prompt('Enter your Google Client ID: ');
  } else {
    console.log(`Using GOOGLE_CLIENT_ID from .env: ${clientId.slice(0, 20)}...`);
  }

  if (!clientSecret) {
    clientSecret = await prompt('Enter your Google Client Secret: ');
  } else {
    console.log(`Using GOOGLE_CLIENT_SECRET from .env: ${clientSecret.slice(0, 10)}...`);
  }

  if (!clientId || !clientSecret) {
    console.error('\nError: Client ID and Client Secret are required.');
    process.exit(1);
  }

  // Dynamically import googleapis — installed in server/node_modules
  let google;
  try {
    const serverModules = path.resolve(__dirname, '..', 'server', 'node_modules');
    ({ google } = require(path.join(serverModules, 'googleapis')));
  } catch {
    try {
      ({ google } = require('googleapis'));
    } catch {
      console.error('\nError: googleapis package not found.');
      console.error('Run: cd server && npm install googleapis');
      process.exit(1);
    }
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent screen to always get a refresh token
  });

  console.log('\n--- Step 1: Open this URL in your browser ---\n');
  console.log(authUrl);
  console.log('\n--- Step 2: Complete the Google consent flow ---');
  console.log('(Waiting for callback on http://localhost:3333/callback ...)\n');

  // Try to open the browser automatically
  const { exec } = require('child_process');
  const openCmd = process.platform === 'win32' ? `start "" "${authUrl}"` :
                  process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
  exec(openCmd, (err) => {
    if (err) console.log('(Could not auto-open browser — please copy the URL above manually)');
  });

  // Start local HTTP server to catch the OAuth callback
  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== '/callback') {
        res.end('Not found');
        return;
      }

      const code = parsed.query.code;
      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code. Please try again.');
        reject(new Error('No auth code received'));
        server.close();
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
            <h2 style="color:#22c55e">✓ Authorization successful!</h2>
            <p>You can close this browser tab and return to your terminal.</p>
          </body></html>
        `);

        console.log('\n=== SUCCESS ===\n');
        console.log('Add these to your .env file:\n');
        console.log(`GOOGLE_CLIENT_ID=${clientId}`);
        console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
        console.log('\nAlso set:');
        console.log('EMAIL_MODE=gmail');
        console.log('EMAIL_FROM=your-gmail@gmail.com');
        console.log('EMAIL_FROM_NAME=Your Name\n');

        if (!tokens.refresh_token) {
          console.warn('WARNING: No refresh token returned.');
          console.warn('This usually means you have already authorized this app.');
          console.warn('To force a new refresh token:');
          console.warn('  1. Go to https://myaccount.google.com/permissions');
          console.warn('  2. Revoke access for your app');
          console.warn('  3. Run this script again\n');
        }

        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500);
        res.end(`Error: ${err.message}`);
        reject(err);
        server.close();
      }
    });

    server.listen(PORT, () => {
      // Server is running, waiting for callback
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\nError: Port ${PORT} is already in use.`);
        console.error('Kill the process using that port and try again.');
      }
      reject(err);
    });
  });
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});

import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root (one level up from server/)
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

export const config = {
  port: +(process.env.PORT ?? '3001'),
  apiSecretKey: process.env.API_SECRET_KEY || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  emailMode: (process.env.EMAIL_MODE || 'mock') as 'mock' | 'gmail' | 'brevo',
  /** Third-party email platform: none = use direct emailMode, mock/instantly/smartlead = use platform adapter */
  emailPlatform: (process.env.EMAIL_PLATFORM || 'none') as 'none' | 'mock' | 'instantly' | 'smartlead',
  // On Linux/Cloud Run use system python3; on Windows dev use local venv
  pythonPath: process.env.PYTHON_PATH || (process.platform === 'win32' ? '.venv/Scripts/python.exe' : '/usr/bin/python3'),
  projectRoot: path.resolve(__dirname, '..', '..'),

  gmail: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    fromEmail: process.env.EMAIL_FROM || '',
    fromName: process.env.EMAIL_FROM_NAME || 'OptiRate',
  },

  testMode: {
    enabled: process.env.EMAIL_TEST_MODE === 'true',
    testEmail: process.env.TEST_EMAIL_ADDRESS || '',
  },

  rateLimits: {
    dailyCap: +(process.env.EMAIL_DAILY_CAP ?? '20'),
    hourlyCap: +(process.env.EMAIL_HOURLY_CAP ?? '10'),
    minDelay: +(process.env.EMAIL_MIN_DELAY ?? '240000'),  // 4 minutes
    maxDelay: +(process.env.EMAIL_MAX_DELAY ?? '540000'),  // 9 minutes
  },

  // ── Third-party email platforms ──────────────────────────────────

  instantly: {
    apiKey: process.env.INSTANTLY_API_KEY || '',
    webhookSecret: process.env.INSTANTLY_WEBHOOK_SECRET || '',
    sendingAccounts: (process.env.INSTANTLY_SENDING_ACCOUNTS || '').split(',').filter(Boolean),
    syncInterval: +(process.env.INSTANTLY_SYNC_INTERVAL ?? '120000'), // 2 minutes
  },

  brevo: {
    apiKey:    process.env.BREVO_API_KEY || '',
    fromEmail: process.env.EMAIL_FROM || '',  // e.g. jordi@optiratesolutions.com
  },

  /** Restrict campaigns to manually-added leads only (safety for testing phase) */
  manualLeadsOnly: process.env.MANUAL_LEADS_ONLY === 'true',

  /** Public URL for webhook callbacks (e.g. https://your-app.run.app) */
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL || '',
};

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

  /** Feature flag: classify auto-replies and extract discovered contacts.
   *  When false, replies that LOOK automated still flip status='replied' (the
   *  legacy behaviour) and the system additionally writes a shadow lead_notes
   *  entry tagged 'auto_reply_candidate' so we can score detector precision
   *  on real traffic before turning it on. Defaults to true. */
  autoReplyHandlingEnabled: process.env.AUTO_REPLY_HANDLING_ENABLED !== 'false',

  /** Feature flag: when true, the Cloud Run API only enqueues scrape jobs
   *  (status='pending') and leaves execution to a separate EC2 worker that
   *  polls Supabase. When false, runScrapeJob() fires inline as today. */
  useRemoteWorker: process.env.USE_REMOTE_WORKER === 'true',

  /** Feature flag: when true, the reply tracker (Gmail + IMAP) automatically
   *  queues every URL it finds in auto-reply bodies for the discovery worker
   *  to scrape via Playwright. When false (default), URLs are NOT auto-queued
   *  — they only get scraped when the user manually promotes a reply from
   *  the Inbox UI. Email candidates are queued either way. Defaults to false
   *  to keep Cloud Run free of unsolicited Chromium spawns. */
  autoQueueUrlsFromReplies: process.env.AUTO_QUEUE_URLS_FROM_REPLIES === 'true',

  /** Recontact cutoff (ISO date, e.g. '2026-08-07'). Mail sent BEFORE this
   *  date stops counting as "already contacted", so those addresses become
   *  eligible for a fresh approach. Set it when the sending domain changes —
   *  a send from a retired domain is not a reason to withhold outreach from
   *  the new one, and without this the address-based dedupe in
   *  getSentEmails() blocks the whole back catalogue forever.
   *
   *  Deliberately date-based rather than a rolling day count: this expresses
   *  a specific one-time event, it is auditable, and it cannot quietly turn
   *  the entire book re-mailable again next quarter.
   *
   *  'bounced' and 'replied' are NEVER date-scoped — see getSentEmails().
   *  Unset (the default) = no cutoff, every past send blocks as before. */
  sendDedupeSince: process.env.SEND_DEDUPE_SINCE || '',
};

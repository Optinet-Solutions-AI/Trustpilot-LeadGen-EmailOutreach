import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root (one level up from server/)
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

export const config = {
  port: +(process.env.PORT ?? '3001'),
  apiSecretKey: process.env.API_SECRET_KEY || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  emailMode: (process.env.EMAIL_MODE || 'mock') as 'mock' | 'gmail',
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
    dailyCap: +(process.env.EMAIL_DAILY_CAP ?? '50'),
    hourlyCap: +(process.env.EMAIL_HOURLY_CAP ?? '20'),
    minDelay: +(process.env.EMAIL_MIN_DELAY ?? '30000'),
    maxDelay: +(process.env.EMAIL_MAX_DELAY ?? '90000'),
  },
};

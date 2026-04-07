import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root (one level up from server/)
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

export const config = {
  port: +(process.env.PORT ?? '3001'),
  apiSecretKey: process.env.API_SECRET_KEY || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  emailMode: (process.env.EMAIL_MODE || 'mock') as 'mock' | 'live',
  // On Linux/Cloud Run use system python3; on Windows dev use local venv
  pythonPath: process.env.PYTHON_PATH || (process.platform === 'win32' ? '.venv/Scripts/python.exe' : '/usr/bin/python3'),
  projectRoot: path.resolve(__dirname, '..', '..'),
};

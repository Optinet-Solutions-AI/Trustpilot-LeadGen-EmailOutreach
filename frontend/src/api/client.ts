import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
});

// Add API key if configured (set NEXT_PUBLIC_API_SECRET_KEY in Vercel env vars)
const apiKey = process.env.NEXT_PUBLIC_API_SECRET_KEY;
if (apiKey) {
  api.interceptors.request.use((config) => {
    config.headers['x-api-key'] = apiKey;
    return config;
  });
}

export default api;

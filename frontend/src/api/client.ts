import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL
    ? `${process.env.NEXT_PUBLIC_API_BASE_URL}/api`
    : '/api',
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

// Extract server error messages and improve network error descriptions
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (!err.response) {
      const url = err.config?.baseURL && err.config?.url
        ? `${err.config.baseURL}${err.config.url}`
        : err.config?.url ?? 'unknown URL';
      err.message = `Network Error — could not reach ${url}. Check NEXT_PUBLIC_API_BASE_URL in Vercel env vars and ensure the backend is running.`;
    } else {
      // Prefer the server's own error message over the generic HTTP status text
      const serverMsg = err.response?.data?.error;
      if (serverMsg) err.message = serverMsg;
    }
    return Promise.reject(err);
  }
);

export default api;

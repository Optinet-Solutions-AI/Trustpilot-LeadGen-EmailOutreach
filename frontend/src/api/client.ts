import axios, { AxiosError, AxiosRequestConfig } from 'axios';

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

// Transient upstream failures we should retry instead of surfacing.
// 429 in particular comes from the API Gateway default quota under bursty mounts,
// not from real client misbehavior — retrying with backoff hides it from users.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;

function backoffMs(attempt: number, retryAfterHeader?: string): number {
  if (retryAfterHeader) {
    const n = Number(retryAfterHeader);
    if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, 8000);
    const date = Date.parse(retryAfterHeader);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 8000));
  }
  const base = 250 * Math.pow(2, attempt); // 250, 500, 1000
  const jitter = Math.random() * 250;
  return base + jitter;
}

type RetryConfig = AxiosRequestConfig & { _retryCount?: number };

// Extract server error messages, retry transient failures, improve network error descriptions
api.interceptors.response.use(
  (res) => res,
  async (err: AxiosError) => {
    const config = err.config as RetryConfig | undefined;
    const status = err.response?.status;

    if (config && status && RETRYABLE_STATUSES.has(status)) {
      const attempt = config._retryCount ?? 0;
      if (attempt < MAX_RETRIES) {
        config._retryCount = attempt + 1;
        const retryAfter = err.response?.headers?.['retry-after'] as string | undefined;
        await new Promise((r) => setTimeout(r, backoffMs(attempt, retryAfter)));
        return api.request(config);
      }
    }

    if (!err.response) {
      const url = err.config?.baseURL && err.config?.url
        ? `${err.config.baseURL}${err.config.url}`
        : err.config?.url ?? 'unknown URL';
      err.message = `Network Error — could not reach ${url}. Check NEXT_PUBLIC_API_BASE_URL in Vercel env vars and ensure the backend is running.`;
    } else if (status === 429) {
      err.message = 'Service is busy (rate limited). Please retry in a moment.';
    } else if (status && status >= 500) {
      const serverMsg = (err.response?.data as { error?: string } | undefined)?.error;
      err.message = serverMsg || `Server error (${status}). Please retry in a moment.`;
    } else {
      const serverMsg = (err.response?.data as { error?: string } | undefined)?.error;
      if (serverMsg) err.message = serverMsg;
    }
    return Promise.reject(err);
  }
);

export default api;

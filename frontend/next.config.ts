import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Static export — serves as a pure SPA, compatible with Vercel static hosting
  output: 'export',

  // Note: rewrites are ignored in static export mode at runtime.
  // For local dev, set NEXT_PUBLIC_API_BASE_URL=http://localhost:3001 in .env.local
  // so axios calls the API directly (no proxy needed).
};

export default nextConfig;

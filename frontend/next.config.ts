import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Static export for PRODUCTION only (Vercel static hosting). In `next dev` we
  // omit it so dynamic routes like /leads/<id> serve on-demand — under
  // output:export every id must be in generateStaticParams(), so deep links
  // 500 locally. Prod build still exports (NODE_ENV=production during build).
  ...(process.env.NODE_ENV === 'production' ? { output: 'export' as const } : {}),

  // Note: rewrites are ignored in static export mode at runtime.
  // For local dev, set NEXT_PUBLIC_API_BASE_URL=http://localhost:3001 in .env.local
  // so axios calls the API directly (no proxy needed).
};

export default nextConfig;

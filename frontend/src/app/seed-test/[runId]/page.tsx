import type { Metadata } from 'next';
import { Suspense } from 'react';
import SeedTest from '../../../views/SeedTest';

// Unlinked page — keep it out of search indexes too.
export const metadata: Metadata = { title: 'Seed Placement Test', robots: { index: false, follow: false } };

// Static shell for `output: 'export'`, same pattern as /leads/[id]: vercel.json
// rewrites /seed-test/:path* to /seed-test/_id, and the view reads the real run
// id from the browser URL.
export function generateStaticParams() {
  return [{ runId: '_id' }];
}

export default function Page() {
  return (
    <Suspense>
      <SeedTest />
    </Suspense>
  );
}

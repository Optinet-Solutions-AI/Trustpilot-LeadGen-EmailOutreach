import type { Metadata } from 'next';
import SeedTest from '../../../views/SeedTest';

// Unlinked page — keep it out of search indexes too.
export const metadata: Metadata = { title: 'Seed Placement Test', robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <SeedTest runId={runId} />;
}

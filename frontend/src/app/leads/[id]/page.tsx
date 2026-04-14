import { Suspense } from 'react';
import LeadDetail from '../../../views/LeadDetail';

// Generate a static shell so dynamic lead URLs work with `output: 'export'`.
// The actual lead ID is read client-side from the browser URL via useParams().
// vercel.json rewrites /leads/:path* → /leads/_id.html to serve this shell.
export function generateStaticParams() {
  return [{ id: '_id' }];
}

export default function Page() {
  return (
    <Suspense>
      <LeadDetail />
    </Suspense>
  );
}

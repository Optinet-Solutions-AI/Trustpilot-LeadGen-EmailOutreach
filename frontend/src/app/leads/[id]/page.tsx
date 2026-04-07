import LeadDetail from '../../../views/LeadDetail';

// Generate a static shell so dynamic lead URLs work with `output: 'export'`.
// The actual lead ID is read client-side from the browser URL via useParams().
export function generateStaticParams() {
  return [{ id: '_id' }];
}

export default function Page() {
  return <LeadDetail />;
}

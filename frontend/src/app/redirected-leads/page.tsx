import { Suspense } from 'react';
import RedirectedLeads from '../../views/RedirectedLeads';

export default function Page() {
  return (
    <Suspense>
      <RedirectedLeads />
    </Suspense>
  );
}

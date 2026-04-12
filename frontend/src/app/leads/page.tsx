import { Suspense } from 'react';
import Leads from '../../views/Leads';

export default function Page() {
  return (
    <Suspense>
      <Leads />
    </Suspense>
  );
}

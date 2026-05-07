import { Suspense } from 'react';
import Prospects from '../../views/Prospects';

export default function Page() {
  return (
    <Suspense>
      <Prospects />
    </Suspense>
  );
}

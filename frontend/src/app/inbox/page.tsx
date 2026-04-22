import { Suspense } from 'react';
import Inbox from '../../views/Inbox';

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <Inbox />
    </Suspense>
  );
}

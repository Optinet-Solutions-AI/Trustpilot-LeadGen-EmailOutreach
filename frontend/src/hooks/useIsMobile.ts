'use client';

import { useEffect, useState } from 'react';

/**
 * SSR-safe matcher for sub-`lg` viewports (< 1024px).
 * Returns `false` on the server and on the first client render to avoid
 * hydration mismatch; flips to the real value after mount.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 1023.98px)');
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  return isMobile;
}

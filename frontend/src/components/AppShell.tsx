'use client';

import { Suspense, useEffect } from 'react';
import { ScrapeProvider } from '../context/ScrapeContext';
import { TaxonomyProvider } from '../context/TaxonomyContext';
import { NotificationsProvider } from '../context/NotificationsContext';
import { UIProvider } from '../context/UIContext';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import api from '../api/client';

export default function AppShell({ children }: { children: React.ReactNode }) {
  // Cloud Run warm-up — fire-and-forget /api/health ping on first mount so
  // the container is awake by the time the user clicks into a heavy view
  // like /leads/:id. Without this, the first request after an idle period
  // pays the 5-15s cold-start cost, which felt like the page was frozen.
  // Failures are silently swallowed: this is a hint, not a precondition,
  // and a real outage will surface on the actual API calls.
  useEffect(() => {
    api.get('/health', { timeout: 8_000 }).catch(() => { /* swallowed */ });
  }, []);

  return (
    <ScrapeProvider>
      <TaxonomyProvider>
        <NotificationsProvider>
          <UIProvider>
            <div className="flex min-h-screen w-full max-w-full bg-background">
              {/* Suspense boundary: Sidebar calls useSearchParams() to drive the
                  per-platform Leads active-state highlight. Next.js 15's
                  static prerender bails out of any tree that reads search
                  params unless that tree is suspended, so we wrap the Sidebar
                  rather than CSR-bail every page. */}
              <Suspense fallback={null}>
                <Sidebar />
              </Suspense>
              <TopBar />
              <main className="flex-1 min-w-0 max-w-full min-h-screen pt-14 lg:pt-16 lg:ml-64">
                {children}
              </main>
            </div>
          </UIProvider>
        </NotificationsProvider>
      </TaxonomyProvider>
    </ScrapeProvider>
  );
}

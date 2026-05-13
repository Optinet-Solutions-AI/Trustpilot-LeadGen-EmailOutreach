'use client';

import { ScrapeProvider } from '../context/ScrapeContext';
import { TaxonomyProvider } from '../context/TaxonomyContext';
import { NotificationsProvider } from '../context/NotificationsContext';
import { UIProvider } from '../context/UIContext';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ScrapeProvider>
      <TaxonomyProvider>
        <NotificationsProvider>
          <UIProvider>
            <div className="flex min-h-screen w-full max-w-full bg-background">
              <Sidebar />
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

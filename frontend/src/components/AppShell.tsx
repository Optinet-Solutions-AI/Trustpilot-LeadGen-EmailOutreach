'use client';

import { ScrapeProvider } from '../context/ScrapeContext';
import { NotificationsProvider } from '../context/NotificationsContext';
import { UIProvider } from '../context/UIContext';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ScrapeProvider>
      <NotificationsProvider>
        <UIProvider>
          <div className="flex min-h-screen bg-background">
            <Sidebar />
            <TopBar />
            <main className="flex-1 min-h-screen pt-14 lg:pt-16 lg:ml-64">
              {children}
            </main>
          </div>
        </UIProvider>
      </NotificationsProvider>
    </ScrapeProvider>
  );
}

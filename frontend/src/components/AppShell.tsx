'use client';

import { ScrapeProvider } from '../context/ScrapeContext';
import { NotificationsProvider } from '../context/NotificationsContext';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ScrapeProvider>
      <NotificationsProvider>
        <div className="flex min-h-screen bg-background">
          <Sidebar />
          <TopBar />
          <main className="ml-64 pt-16 flex-1 min-h-screen">
            {children}
          </main>
        </div>
      </NotificationsProvider>
    </ScrapeProvider>
  );
}

'use client';

import { ScrapeProvider } from '../context/ScrapeContext';
import Sidebar from './Sidebar';

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ScrapeProvider>
      <div className="flex min-h-screen bg-gray-50">
        <Sidebar />
        <main className="flex-1 p-6 overflow-auto">
          {children}
        </main>
      </div>
    </ScrapeProvider>
  );
}

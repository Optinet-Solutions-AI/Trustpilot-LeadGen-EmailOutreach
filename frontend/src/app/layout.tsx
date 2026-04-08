import type { Metadata } from 'next';
import './globals.css';
import AppShell from '../components/AppShell';

export const metadata: Metadata = {
  title: 'Trustpilot CRM',
  description: 'Lead Gen & Email Outreach',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

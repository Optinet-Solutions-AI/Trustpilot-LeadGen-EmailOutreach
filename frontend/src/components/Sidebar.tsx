'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Search, Users, Mail, BarChart3, FlaskConical } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/scrape', icon: Search, label: 'Scrape' },
  { href: '/leads', icon: Users, label: 'Leads' },
  { href: '/campaigns', icon: Mail, label: 'Campaigns' },
  { href: '/analytics', icon: BarChart3, label: 'Analytics' },
];

const isTestMode = process.env.NEXT_PUBLIC_EMAIL_TEST_MODE === 'true';

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 bg-gray-900 text-white flex flex-col min-h-screen">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-lg font-bold">Trustpilot CRM</h1>
        <p className="text-xs text-gray-400 mt-0.5">Lead Gen & Outreach</p>
      </div>

      {isTestMode && (
        <div className="mx-3 mt-3 px-3 py-2 bg-yellow-400/20 border border-yellow-400/40 rounded-md">
          <div className="flex items-center gap-1.5 text-yellow-300 text-xs font-semibold">
            <FlaskConical size={12} />
            TEST MODE ON
          </div>
          <p className="text-yellow-400/80 text-xs mt-0.5 leading-tight">
            Emails redirect to test inboxes — no real prospects contacted
          </p>
        </div>
      )}
      <nav className="flex-1 py-4">
        {NAV_ITEMS.map(({ href, icon: Icon, label }) => {
          const isActive = href === '/' ? pathname === '/' : (pathname ?? '').startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                isActive
                  ? 'bg-gray-800 text-white font-medium'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
              }`}
            >
              <Icon size={18} />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

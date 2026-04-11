'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useScrape } from '../hooks/useScrape';

const NAV_ITEMS = [
  { href: '/scrape',          icon: 'search_check',     label: 'Lead Scraping' },
  { href: '/leads',           icon: 'grid_view',        label: 'Lead Matrix' },
  { href: '/inbox',           icon: 'inbox',            label: 'Inbox' },
  { href: '/analytics',       icon: 'bar_chart',        label: 'Analytics' },
  { href: '/campaigns',       icon: 'magic_button',     label: 'Campaign Wizard' },
  { href: '/email-accounts',  icon: 'alternate_email',  label: 'Email Accounts' },
];

const isTestMode = process.env.NEXT_PUBLIC_EMAIL_TEST_MODE === 'true';

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { status } = useScrape();

  return (
    <aside className="h-full w-64 fixed left-0 top-0 bg-slate-50 flex flex-col py-6 px-4 z-50">
      {/* Brand */}
      <div className="mb-8 px-2">
        <button
          onClick={() => router.push('/')}
          className="text-left hover:opacity-80 transition-opacity"
        >
          <h1 className="text-2xl font-black tracking-tighter text-[#b0004a]" style={{ fontFamily: 'Manrope, sans-serif' }}>
            Elite Outreach
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-0.5">
            Trustpilot Edition
          </p>
        </button>
      </div>

      {/* Test Mode Badge */}
      {isTestMode && (
        <div className="mx-0 mb-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex items-center gap-1.5 text-amber-700 text-xs font-bold">
            <span className="material-symbols-outlined text-sm">science</span>
            TEST MODE
          </div>
          <p className="text-amber-600/80 text-[10px] mt-0.5 leading-tight">
            Emails redirect to test inbox
          </p>
        </div>
      )}

      {/* New Campaign CTA */}
      <Link
        href="/campaigns"
        className="mb-6 w-full py-3 primary-gradient text-white rounded-lg font-bold text-sm flex items-center justify-center gap-2 ambient-shadow hover:scale-[1.02] transition-transform"
        style={{ fontFamily: 'Manrope, sans-serif' }}
      >
        <span className="material-symbols-outlined text-[18px]">add</span>
        New Campaign
      </Link>

      {/* Navigation */}
      <nav className="flex-1 space-y-1">
        {NAV_ITEMS.map(({ href, icon, label }) => {
          const isActive = href === '/' ? pathname === '/' : (pathname ?? '').startsWith(href);
          const isScrapeRunning = href === '/scrape' && status === 'running';

          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                isActive
                  ? 'text-[#b0004a] font-bold border-r-4 border-[#b0004a] translate-x-0.5 bg-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-200/50 hover:text-slate-900'
              }`}
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              <span
                className="material-symbols-outlined text-[20px]"
                style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                {icon}
              </span>
              {label}
              {isScrapeRunning && (
                <span className="ml-auto flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-[#b0004a] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[#b0004a]" />
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Bottom Section */}
      <div className="mt-auto pt-6 space-y-1 border-t border-slate-100">
        <a
          href="#"
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-500 text-sm font-medium hover:bg-slate-200/50 hover:text-slate-700 transition-colors"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          <span className="material-symbols-outlined text-[20px]">settings</span>
          Settings
        </a>
        <a
          href="#"
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-500 text-sm font-medium hover:bg-slate-200/50 hover:text-slate-700 transition-colors"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          <span className="material-symbols-outlined text-[20px]">help</span>
          Support
        </a>
      </div>
    </aside>
  );
}

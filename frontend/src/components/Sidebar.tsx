'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useScrape } from '../hooks/useScrape';
import { useNotifications } from '../context/NotificationsContext';
import { useDiscoveryCount } from '../hooks/useDiscoveredContacts';
import { useUI } from '../context/UIContext';

// `platform` is the optional ?platform= query value an entry matches against.
// Used by the per-platform Lead Matrix entries — three /leads-prefixed
// entries can coexist without all lighting up at once.
interface NavItem {
  href: string;
  icon: string;
  label: string;
  platform?: string;   // undefined = match only when no ?platform= on /leads
}

const NAV_ITEMS: NavItem[] = [
  { href: '/scrape',                                icon: 'search_check',     label: 'Lead Scraping' },
  { href: '/leads',                                 icon: 'grid_view',        label: 'Lead Matrix' },
  { href: '/leads?platform=trustpilot',             icon: 'workspace_premium',label: 'Trustpilot Leads',  platform: 'trustpilot' },
  { href: '/leads?platform=tripadvisor',            icon: 'travel_explore',   label: 'TripAdvisor Leads', platform: 'tripadvisor' },
  { href: '/leads?platform=yelp',                   icon: 'storefront',       label: 'Yelp Leads',        platform: 'yelp' },
  { href: '/redirected-leads',                      icon: 'compare_arrows',   label: 'Redirected Leads' },
  { href: '/prospects',                             icon: 'how_to_reg',       label: 'Prospects' },
  { href: '/inbox',                                 icon: 'inbox',            label: 'Inbox' },
  { href: '/analytics',                             icon: 'bar_chart',        label: 'Analytics' },
  { href: '/campaigns',                             icon: 'magic_button',     label: 'Campaign Wizard' },
  { href: '/email-accounts',                        icon: 'alternate_email',  label: 'Email Accounts' },
  { href: '/warmup-peers',                          icon: 'groups',           label: 'Warmup Peers' },
  { href: '/affiliate-monitor',                     icon: 'monitoring',       label: 'Affiliate Monitor' },
];

const isTestMode = process.env.NEXT_PUBLIC_EMAIL_TEST_MODE === 'true';

export default function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { status } = useScrape();
  const { unreadCount } = useNotifications();
  const pendingDiscoveries = useDiscoveryCount();
  const { drawerOpen, closeDrawer } = useUI();
  const currentPlatformParam = searchParams?.get('platform') ?? null;

  return (
    <>
      {/* Backdrop — visible only when drawer is open on `< lg` */}
      <div
        onClick={closeDrawer}
        aria-hidden
        className={`fixed inset-0 bg-black/40 z-40 transition-opacity lg:hidden ${
          drawerOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />

      <aside
        data-open={drawerOpen}
        className={`
          fixed left-0 top-0 h-full w-64 bg-slate-50 flex flex-col py-6 px-4 z-50
          transition-transform duration-200
          -translate-x-full data-[open=true]:translate-x-0
          lg:translate-x-0 lg:data-[open=false]:translate-x-0
        `}
      >
        {/* Brand */}
        <div className="mb-8 px-2 flex items-center justify-between">
          <button
            onClick={() => { closeDrawer(); router.push('/'); }}
            className="text-left hover:opacity-80 transition-opacity"
          >
            <h1 className="text-2xl font-black tracking-tighter text-[#b0004a]" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Elite Outreach
            </h1>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-0.5">
              Trustpilot Edition
            </p>
          </button>
          <button
            onClick={closeDrawer}
            aria-label="Close menu"
            className="lg:hidden text-slate-500 hover:text-[#b0004a] p-1"
          >
            <span className="material-symbols-outlined">close</span>
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
          onClick={closeDrawer}
          className="mb-6 w-full py-3 primary-gradient text-white rounded-lg font-bold text-sm flex items-center justify-center gap-2 ambient-shadow hover:scale-[1.02] transition-transform"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          New Campaign
        </Link>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map(({ href, icon, label, platform }) => {
            // The /leads tree has three entries that share a pathname; we
            // disambiguate by ?platform=. Other entries fall back to the
            // legacy "pathname starts with href" rule.
            const path = (pathname ?? '');
            const onLeads = path.startsWith('/leads') && !path.startsWith('/leads/');
            let isActive: boolean;
            if (onLeads && href.startsWith('/leads')) {
              if (platform) {
                isActive = currentPlatformParam === platform;
              } else {
                // Base /leads entry — active only when no ?platform= is set
                isActive = path === '/leads' && currentPlatformParam === null;
              }
            } else {
              isActive = href === '/' ? path === '/' : path.startsWith(href.split('?')[0]);
            }
            const isScrapeRunning = href === '/scrape' && status === 'running';
            const showInboxBadge = href === '/inbox' && unreadCount > 0;
            const showProspectsBadge = href === '/prospects' && pendingDiscoveries > 0;

            return (
              <Link
                key={href}
                href={href}
                onClick={closeDrawer}
                className={`flex items-center gap-3 px-3 py-3 lg:py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
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
                {showInboxBadge && (
                  <span className="ml-auto text-[10px] font-black bg-[#b0004a] text-white rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center leading-none">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
                {showProspectsBadge && (
                  <span className="ml-auto text-[10px] font-black bg-[#006630] text-white rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center leading-none">
                    {pendingDiscoveries > 99 ? '99+' : pendingDiscoveries}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Bottom Section */}
        <div className="mt-auto pt-6 space-y-1 border-t border-slate-100">
          <button
            disabled
            title="Coming soon"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 text-sm font-medium opacity-40 cursor-not-allowed"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            <span className="material-symbols-outlined text-[20px]">settings</span>
            Settings
          </button>
          <a
            href="mailto:support@optinetsolutions.com"
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-500 text-sm font-medium hover:bg-slate-200/50 hover:text-slate-700 transition-colors"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            <span className="material-symbols-outlined text-[20px]">help</span>
            Support
          </a>
        </div>
      </aside>
    </>
  );
}

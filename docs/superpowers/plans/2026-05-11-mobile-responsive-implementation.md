# Mobile Responsive Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every page of the OptiRate dashboard usable on phones (375px+) without regressing the desktop experience.

**Architecture:** Tailwind v4 with default breakpoints. Binary mobile↔desktop split at `lg` (1024px). Drawer sidebar below `lg`, fixed sidebar above. Tables render two children: existing `<table>` inside `hidden lg:block`, new card list inside `lg:hidden`. Modals become full-screen sheets below `lg`. New shared primitives: `useIsMobile` hook, `MobileBottomSheet` component, lifted drawer state in `AppShell`.

**Tech Stack:** Next.js 15 (app router), React 19, Tailwind CSS v4, TypeScript 5, Recharts 3, lucide-react.

**Spec:** [`docs/superpowers/specs/2026-05-11-mobile-responsive-design.md`](../specs/2026-05-11-mobile-responsive-design.md)

**Verification model:** No test runner exists in `frontend/`. Each task verifies via:
1. `cd frontend && npx tsc --noEmit` (must stay green)
2. Manual: open `npm run dev` at `localhost:5173` (or whichever port Next picks), use Chrome DevTools device toolbar to switch viewports, confirm described behavior.
3. Final phase uses `webapp-testing` (Playwright) for breakpoint screenshot capture.

**Commit cadence:** Commit after every task. The user's CLAUDE.md requires a Conventional Commit suggestion. Use `feat(frontend):` / `refactor(frontend):` scopes.

---

## File Structure

**New files:**
- `frontend/src/hooks/useIsMobile.ts` — SSR-safe matchMedia hook returning `true` below 1024px.
- `frontend/src/context/UIContext.tsx` — drawer open/close state + body scroll lock.
- `frontend/src/components/MobileBottomSheet.tsx` — reusable bottom-sheet primitive.
- `frontend/src/components/MobileDrawer.tsx` — drawer wrapper around `Sidebar` content.

**Modified (in order):**
1. `AppShell.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `globals.css` (shell + global)
2. Each table-bearing component (`LeadsTable.tsx`, etc.)
3. Each wizard step + `CampaignWizard.tsx`
4. Each modal (`TestFlightModal.tsx`, etc.)
5. Each view in `frontend/src/views/*`
6. `affiliate-monitor/*` sub-components

**Untouched:** `frontend/src/app/**/*.tsx` route shells, all backend code, all hooks/types unrelated to UI state.

---

## Phase 1 — Foundation primitives

### Task 1: `useIsMobile` hook

**Files:**
- Create: `frontend/src/hooks/useIsMobile.ts`

- [ ] **Step 1: Write the hook**

```ts
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
```

- [ ] **Step 2: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useIsMobile.ts
git commit -m "feat(frontend): add useIsMobile hook for sub-lg viewport detection"
```

---

### Task 2: `UIContext` for drawer state

**Files:**
- Create: `frontend/src/context/UIContext.tsx`

- [ ] **Step 1: Write the context**

```tsx
'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

interface UIContextValue {
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
}

const UIContext = createContext<UIContextValue | null>(null);

export function UIProvider({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const toggleDrawer = useCallback(() => setDrawerOpen((v) => !v), []);

  // Body scroll lock while drawer is open. iOS Safari needs the
  // position-fixed trick; restore scroll position on close.
  useEffect(() => {
    if (!drawerOpen) return;
    const scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    return () => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, scrollY);
    };
  }, [drawerOpen]);

  // ESC key closes the drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDrawer(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, closeDrawer]);

  return (
    <UIContext.Provider value={{ drawerOpen, openDrawer, closeDrawer, toggleDrawer }}>
      {children}
    </UIContext.Provider>
  );
}

export function useUI(): UIContextValue {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error('useUI must be used within UIProvider');
  return ctx;
}
```

- [ ] **Step 2: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/context/UIContext.tsx
git commit -m "feat(frontend): add UIContext for drawer state with scroll lock + ESC close"
```

---

### Task 3: `MobileBottomSheet` primitive

**Files:**
- Create: `frontend/src/components/MobileBottomSheet.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional title rendered in the sheet header. */
  title?: string;
  children: React.ReactNode;
  /** Max height as a CSS length; defaults to 80vh. */
  maxHeight?: string;
}

/**
 * Bottom sheet for mobile. Centered/positioned dropdowns on desktop should
 * NOT use this — they should keep their existing absolute layout and
 * conditionally render this on `< sm` instead. Caller is responsible for
 * the conditional.
 */
export default function MobileBottomSheet({ open, onClose, title, children, maxHeight = '80vh' }: Props) {
  // ESC closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 z-[60]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-x-0 bottom-0 z-[61] bg-white rounded-t-2xl shadow-2xl flex flex-col"
        style={{ maxHeight }}
      >
        {title && (
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
            <p className="text-sm font-extrabold text-on-surface">{title}</p>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-slate-500 hover:text-[#b0004a] -mr-2 p-2"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        )}
        <div className="overflow-y-auto flex-1">{children}</div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/MobileBottomSheet.tsx
git commit -m "feat(frontend): add MobileBottomSheet primitive for sub-lg dropdowns and filters"
```

---

### Task 4: Global mobile-input CSS guard

**Files:**
- Modify: `frontend/src/app/globals.css` (append new section before `─── Selection ───`)

- [ ] **Step 1: Add iOS-zoom guard**

Append before the `Selection` section in `globals.css`:

```css
/* ─── Mobile input zoom guard ───────────────────────────────────────────────── */
/* iOS Safari auto-zooms on focus when input font-size is < 16px. Force 16px
   on touch viewports while keeping the visual sm:text-sm in our design. */
@media (max-width: 639px) {
  input[type="text"],
  input[type="email"],
  input[type="search"],
  input[type="number"],
  input[type="tel"],
  input[type="url"],
  input[type="password"],
  textarea,
  select {
    font-size: 16px !important;
  }
}

/* ─── Mobile-only utilities ─────────────────────────────────────────────────── */
/* Sticky bottom action bar used by tables in selection mode and the wizard
   footer. Rendered only on `< lg` via Tailwind classes; this just provides
   the safe-area inset on iOS notch devices. */
.mobile-action-bar {
  padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
}
```

- [ ] **Step 2: Manual viewport check**

Run: `cd frontend && npm run dev`
Open Chrome DevTools → device toolbar → iPhone SE (375×667). Open `/scrape`. Tap the country select. Confirm the page does NOT zoom in on focus.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/globals.css
git commit -m "fix(frontend): stop iOS Safari zoom on input focus for sub-sm viewports"
```

---

## Phase 2 — Shell

### Task 5: Wire `UIProvider` into `AppShell` and add full-width main on mobile

**Files:**
- Modify: `frontend/src/components/AppShell.tsx`

- [ ] **Step 1: Replace contents**

```tsx
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
```

- [ ] **Step 2: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/AppShell.tsx
git commit -m "refactor(frontend): wire UIProvider and gate sidebar offset to lg in AppShell"
```

---

### Task 6: `Sidebar` — drawer mode below `lg`

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`

- [ ] **Step 1: Replace contents**

```tsx
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useScrape } from '../hooks/useScrape';
import { useNotifications } from '../context/NotificationsContext';
import { useDiscoveryCount } from '../hooks/useDiscoveredContacts';
import { useUI } from '../context/UIContext';

const NAV_ITEMS = [
  { href: '/scrape',          icon: 'search_check',     label: 'Lead Scraping' },
  { href: '/leads',           icon: 'grid_view',        label: 'Lead Matrix' },
  { href: '/redirected-leads', icon: 'compare_arrows',  label: 'Redirected Leads' },
  { href: '/prospects',       icon: 'how_to_reg',       label: 'Prospects' },
  { href: '/inbox',           icon: 'inbox',            label: 'Inbox' },
  { href: '/analytics',       icon: 'bar_chart',        label: 'Analytics' },
  { href: '/campaigns',       icon: 'magic_button',     label: 'Campaign Wizard' },
  { href: '/email-accounts',  icon: 'alternate_email',  label: 'Email Accounts' },
  { href: '/warmup-peers',    icon: 'groups',           label: 'Warmup Peers' },
  { href: '/affiliate-monitor', icon: 'monitoring',      label: 'Affiliate Monitor' },
];

const isTestMode = process.env.NEXT_PUBLIC_EMAIL_TEST_MODE === 'true';

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { status } = useScrape();
  const { unreadCount } = useNotifications();
  const pendingDiscoveries = useDiscoveryCount();
  const { drawerOpen, closeDrawer } = useUI();

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
          {NAV_ITEMS.map(({ href, icon, label }) => {
            const isActive = href === '/' ? pathname === '/' : (pathname ?? '').startsWith(href);
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
```

- [ ] **Step 2: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 3: Manual verification at 375px**

Sidebar should be hidden by default. (Nothing opens it yet — TopBar hamburger comes in Task 7.) At 1024px+ the sidebar should look identical to before.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Sidebar.tsx
git commit -m "feat(frontend): convert Sidebar to off-canvas drawer below lg breakpoint"
```

---

### Task 7: `TopBar` — hamburger, full-width on mobile, brand hide

**Files:**
- Modify: `frontend/src/components/TopBar.tsx`

- [ ] **Step 1: Header section + hamburger**

Replace lines 65–80 (the `<header>` opening + Search div) with:

```tsx
  return (
    <header className="fixed top-0 right-0 left-0 lg:left-64 h-14 lg:h-16 glass-panel border-b border-slate-100 z-40 flex justify-between items-center px-3 sm:px-4 xl:px-8 gap-2">
      {/* Left cluster: hamburger + search */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <button
          onClick={toggleDrawer}
          aria-label="Open menu"
          className="lg:hidden text-slate-600 hover:text-[#b0004a] p-2 -ml-2"
        >
          <span className="material-symbols-outlined">menu</span>
        </button>

        {/* Search — icon-only on `< sm`, expanding overlay on tap; full input on `sm+` */}
        <div className="relative flex-1 max-w-xs sm:max-w-none sm:w-56 xl:w-80">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[18px] pointer-events-none">
            search
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearch}
            placeholder="Search leads…"
            className="w-full bg-surface-container-low border-none rounded-lg py-2 pl-10 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#b0004a]/20 transition-all"
          />
        </div>
      </div>
```

- [ ] **Step 2: Add `useUI` import + `toggleDrawer` destructure**

At the top of the file, near the other imports:

```tsx
import { useUI } from '../context/UIContext';
```

Inside `TopBar()`, after the other hook calls (around line 40):

```tsx
  const { toggleDrawer } = useUI();
```

- [ ] **Step 3: Hide brand block below `sm`**

Replace the brand block (last `<div>` inside the right controls — currently `<div className="pl-4 border-l border-slate-200">`) with:

```tsx
        {/* Brand label — desktop only */}
        <div className="hidden sm:block pl-4 border-l border-slate-200">
          <p className="text-xs font-bold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>OptiRate</p>
          <p className="text-[10px] text-slate-500">Test Phase</p>
        </div>
```

- [ ] **Step 4: Reduce right-cluster gap on mobile**

Find `<div className="flex items-center gap-5">` (the right-controls wrapper) and change to:

```tsx
      <div className="flex items-center gap-3 sm:gap-5">
```

- [ ] **Step 5: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 6: Manual verification at 375px**

- Tap hamburger → sidebar slides in from left.
- Tap a nav item → drawer closes and route changes.
- Tap backdrop → drawer closes.
- At `lg` (1024px), no hamburger visible; sidebar always visible.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/TopBar.tsx
git commit -m "feat(frontend): add mobile hamburger and full-width topbar below lg"
```

---

### Task 8: `TopBar` notification + help dropdowns → bottom sheets on `< sm`

**Files:**
- Modify: `frontend/src/components/TopBar.tsx`

- [ ] **Step 1: Add imports + mobile flag**

Add to the imports:

```tsx
import MobileBottomSheet from './MobileBottomSheet';
import { useIsMobile } from '../hooks/useIsMobile';
```

Inside `TopBar()`, near the existing state:

```tsx
  const isMobile = useIsMobile();
```

- [ ] **Step 2: Wrap the notifications dropdown**

Replace the existing `{showNotif && (...)}` block (the absolutely-positioned dropdown at lines ~103–167) with a conditional that uses the bottom sheet on mobile and the existing dropdown on desktop. The dropdown body markup is identical — only the wrapper changes:

```tsx
          {/* Mobile: bottom sheet */}
          {isMobile ? (
            <MobileBottomSheet
              open={showNotif}
              onClose={() => setShowNotif(false)}
              title={`Notifications${unreadCount > 0 ? ` · ${unreadCount}` : ''}`}
            >
              <NotificationsList
                items={items}
                loading={loading}
                unreadCount={unreadCount}
                onMarkAllRead={() => markAllRead()}
                onOpen={openReply}
                onOpenInbox={() => { setShowNotif(false); router.push('/inbox'); }}
              />
            </MobileBottomSheet>
          ) : (
            showNotif && (
              <div className="absolute right-0 top-10 w-80 bg-white rounded-xl ambient-shadow border border-slate-100 overflow-hidden z-50">
                {/* existing desktop header */}
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                  <p className="text-xs font-extrabold uppercase tracking-wider text-slate-500">
                    Notifications {unreadCount > 0 && <span className="text-[#b0004a]">· {unreadCount}</span>}
                  </p>
                  {unreadCount > 0 && (
                    <button onClick={() => markAllRead()} className="text-[10px] font-bold text-[#b0004a] hover:underline">
                      Mark all read
                    </button>
                  )}
                </div>
                <NotificationsList
                  items={items}
                  loading={loading}
                  unreadCount={unreadCount}
                  onMarkAllRead={() => markAllRead()}
                  onOpen={openReply}
                  onOpenInbox={() => { setShowNotif(false); router.push('/inbox'); }}
                  hideHeader
                />
              </div>
            )
          )}
```

- [ ] **Step 3: Extract `NotificationsList` helper component**

At the bottom of `TopBar.tsx` (before the default export, or in a sibling file — keep it in the same file for cohesion):

```tsx
interface NotificationsListProps {
  items: ReturnType<typeof useNotifications>['items'];
  loading: boolean;
  unreadCount: number;
  onMarkAllRead: () => void;
  onOpen: (id: string) => void;
  onOpenInbox: () => void;
  hideHeader?: boolean;
}

function NotificationsList({ items, loading, unreadCount, onMarkAllRead, onOpen, onOpenInbox, hideHeader }: NotificationsListProps) {
  return (
    <>
      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-10 gap-2 text-secondary text-sm">
          <span className="material-symbols-outlined text-[#b0004a] text-[18px] animate-spin">progress_activity</span>
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <span className="material-symbols-outlined text-slate-300 text-[40px] block mb-2">notifications_none</span>
          <p className="text-sm font-semibold text-secondary">All caught up</p>
          <p className="text-xs text-slate-400 mt-1">New replies to your outreach appear here.</p>
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto divide-y divide-slate-50">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => onOpen(item.id)}
              className="w-full text-left px-4 py-3 hover:bg-[#ffd9de]/10 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-[#8ff9a8]/30 flex items-center justify-center text-[#006630] flex-shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-[16px]">reply</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <p className="text-xs font-extrabold text-on-surface truncate">{item.company_name}</p>
                    <span className="text-[10px] text-slate-400 flex-shrink-0">{formatRelative(item.replied_at)}</span>
                  </div>
                  <p className="text-[10px] text-secondary mb-1 truncate">{item.campaign_name}</p>
                  {item.reply_snippet && (
                    <p className="text-[11px] text-[#006630] line-clamp-2 italic">{item.reply_snippet}</p>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="px-4 py-2 border-t border-slate-100 bg-surface-container-low">
        <button onClick={onOpenInbox} className="w-full text-xs font-bold text-[#b0004a] hover:underline py-1">
          Open Outreach Inbox →
        </button>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Repeat the same pattern for the Help dropdown**

Wrap `{showHelp && (...)}` in the same `isMobile ? <MobileBottomSheet> : <existing dropdown>` conditional. Extract a `HelpList` component if it makes the conditional cleaner; otherwise inline both branches with identical body markup.

- [ ] **Step 5: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 6: Manual verification at 375px**

Tap notifications icon → sheet slides up from bottom. Tap backdrop → closes. Same for help. At `sm:` (640px+) and above, original dropdowns appear.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/TopBar.tsx
git commit -m "feat(frontend): notifications and help open as bottom sheets on mobile"
```

---

## Phase 3 — Tables → cards

> **Pattern for every table task in this phase:** keep the existing `<table>` wrapped in `<div className="hidden lg:block">`. Add a new mobile card list in `<div className="lg:hidden space-y-2 px-3">` rendering the same data. Wire the existing row-click handler to the card. If the table has bulk-select checkboxes, render them on the card; if `selected.length > 0`, append a `<div className="lg:hidden fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 px-4 py-3 mobile-action-bar z-30 flex items-center justify-between gap-3">…</div>` with the bulk action buttons.

### Task 9: `LeadsTable` mobile card list

**Files:**
- Modify: `frontend/src/components/LeadsTable.tsx`

- [ ] **Step 1: Locate the existing table and bulk-select state**

Read the full file. Identify where `<table>` opens, where rows render, where bulk-select checkboxes live, and where the toolbar/actions render. Note state names: `selected` (array of lead ids), and any `onClick` handler that opens lead detail.

- [ ] **Step 2: Wrap existing table in a desktop-only div**

Find the outer wrapper of the existing `<table>` and add `className="hidden lg:block"` to it (preserving any existing classes). If the wrapper has scroll/overflow classes, keep them.

- [ ] **Step 3: Add mobile card list directly after the desktop wrapper**

Insert this block after the `</div>` that closes the desktop wrapper:

```tsx
{/* Mobile card list — `< lg` */}
<div className="lg:hidden space-y-2 px-3 pb-24">
  {leads.length === 0 ? (
    <div className="text-center py-12 text-secondary text-sm">No leads match these filters.</div>
  ) : (
    leads.map((lead) => {
      const isChecked = selected.includes(lead.id);
      const verifyStatus = resolveDisplayStatus(
        lead.primary_email_verification_status,
        lead.primary_email,
        lead
      );
      return (
        <div
          key={lead.id}
          className="bg-white rounded-xl border border-slate-100 p-3 flex gap-3 active:bg-slate-50"
          onClick={() => onRowClick?.(lead.id)}
        >
          <label
            className="flex items-start pt-1"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={isChecked}
              onChange={() => toggleSelect(lead.id)}
              className="w-5 h-5 accent-[#b0004a]"
            />
          </label>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="font-bold text-sm text-on-surface truncate">{lead.company_name}</p>
              {lead.star_rating != null && (
                <span className="flex-shrink-0 text-xs text-amber-600 font-bold">
                  ★ {lead.star_rating.toFixed(1)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-secondary mb-1.5">
              {lead.country && <span>{lead.country}</span>}
              {lead.category && <span className="truncate">· {lead.category}</span>}
            </div>
            {lead.primary_email && (
              <div className="flex items-center gap-2 mb-1.5">
                <p className="text-xs text-slate-700 truncate flex-1">{lead.primary_email}</p>
                {verifyStatus && (
                  <VerifyBadge status={verifyStatus} sourceEmail={lead.primary_email} lead={lead} />
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <StatusBadge status={lead.outreach_status} />
              <LeadLinkWarning lead={lead} />
            </div>
          </div>
        </div>
      );
    })
  )}
</div>
```

> If `LeadsTable` uses different prop/state names (`onRowClick`, `selected`, `toggleSelect`), substitute the actual names from the existing component in this file. Do not invent new ones.

- [ ] **Step 4: Add sticky bulk-action bar below `lg`**

After the mobile card list block, when `selected.length > 0`:

```tsx
{selected.length > 0 && (
  <div className="lg:hidden fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 px-4 py-3 mobile-action-bar z-30 flex items-center justify-between gap-3 shadow-2xl">
    <p className="text-xs font-bold text-on-surface">
      {selected.length} selected
    </p>
    <div className="flex items-center gap-2">
      {/* Mirror whichever bulk actions the desktop toolbar exposes.
          Read the existing toolbar in this component and call the same handlers. */}
    </div>
  </div>
)}
```

Fill in the bulk-action buttons by mirroring the existing desktop toolbar in this same file (Enrich, Verify, Update Status, Delete, etc.). Do not add new actions.

- [ ] **Step 5: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 6: Manual verification**

At 375px on `/leads`: rows appear as cards; tapping a card opens lead detail; tapping the checkbox does NOT open detail; bulk action bar appears at bottom when 1+ selected. At `lg:` (1024px+): original table renders; no card list visible.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/LeadsTable.tsx
git commit -m "feat(frontend): card view + sticky bulk bar for LeadsTable below lg"
```

---

### Task 10: `Leads` view filter toolbar → bottom sheet on `< sm`

**Files:**
- Modify: `frontend/src/views/Leads.tsx`

- [ ] **Step 1: Inspect existing filter row**

Read the file. Find the current filter toolbar (country select, category select, star-rating range, status filter, search). Note its state hooks.

- [ ] **Step 2: Replace toolbar JSX**

Wrap the existing filter row in `<div className="hidden sm:flex …">` (preserving its classes). Add a mobile filter trigger directly above it:

```tsx
<div className="sm:hidden px-3 pt-3 pb-2 flex items-center justify-between gap-2">
  <button
    onClick={() => setFilterSheetOpen(true)}
    className="flex items-center gap-2 px-3 py-2 bg-white rounded-lg border border-slate-200 text-sm font-bold text-on-surface"
  >
    <span className="material-symbols-outlined text-[18px]">filter_list</span>
    Filters
    {activeFilterCount > 0 && (
      <span className="text-[10px] font-black bg-[#b0004a] text-white rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center leading-none">
        {activeFilterCount}
      </span>
    )}
  </button>
  <p className="text-xs text-secondary">
    {totalCount.toLocaleString()} leads
  </p>
</div>

<MobileBottomSheet
  open={filterSheetOpen}
  onClose={() => setFilterSheetOpen(false)}
  title="Filter leads"
>
  <div className="p-4 space-y-4">
    {/* Move each filter control here, full-width.
        Each <select> / <input> uses className="w-full ...".
        Add an "Apply" button at the bottom that closes the sheet. */}
  </div>
</MobileBottomSheet>
```

- [ ] **Step 3: Add state + helpers**

```tsx
import { useState } from 'react';
import MobileBottomSheet from '../components/MobileBottomSheet';

// inside component
const [filterSheetOpen, setFilterSheetOpen] = useState(false);
const activeFilterCount =
  (countryFilter ? 1 : 0) +
  (categoryFilter ? 1 : 0) +
  (statusFilter ? 1 : 0) +
  (minRating != null ? 1 : 0) +
  (maxRating != null ? 1 : 0);
```

(Substitute the actual state names used in `Leads.tsx`.)

- [ ] **Step 4: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 5: Manual verification at 375px**

`/leads` shows a "Filters" button. Tap → sheet rises with all filter controls. Selecting a filter immediately filters the list (or, if Apply button used, applies on Apply tap).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/views/Leads.tsx
git commit -m "feat(frontend): collapse Leads filters into bottom sheet below sm"
```

---

### Task 11: `LeadPipeline` (Kanban) — single-column on mobile

**Files:**
- Modify: `frontend/src/components/LeadPipeline.tsx`

- [ ] **Step 1: Inspect Kanban grid**

Read the file. Find the column wrapper (likely `grid grid-cols-5` or similar).

- [ ] **Step 2: Convert column container**

Change column grid to `grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3`. On mobile, columns stack vertically — each pipeline stage becomes a collapsible section.

Wrap each column body in a `<details>` element so users can collapse stages they aren't actively triaging on mobile:

```tsx
<details open className="bg-white rounded-xl border border-slate-100 lg:open">
  <summary className="lg:hidden px-4 py-3 font-bold text-sm cursor-pointer flex items-center justify-between">
    {stageLabel}
    <span className="text-xs text-secondary">{stageLeads.length}</span>
  </summary>
  <div className="hidden lg:flex lg:items-center lg:justify-between px-3 pt-3 pb-1">
    <p className="font-bold text-sm">{stageLabel}</p>
    <span className="text-xs text-secondary">{stageLeads.length}</span>
  </div>
  <div className="p-2 space-y-2">
    {stageLeads.map(lead => <LeadCard key={lead.id} lead={lead} />)}
  </div>
</details>
```

- [ ] **Step 3: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 4: Manual verification at 375px**

Pipeline page shows one stage per row, collapsible. At `md:` (768px+), 3 columns. At `lg:` (1024px+), 5 columns (or whatever the original count was).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/LeadPipeline.tsx
git commit -m "feat(frontend): collapse pipeline columns into stacked sections below lg"
```

---

### Task 12: `Inbox` view — list-only on mobile, full-screen reply

**Files:**
- Modify: `frontend/src/views/Inbox.tsx`

- [ ] **Step 1: Inspect layout**

Read the file. The Inbox is currently a side-by-side list + reading pane (`grid-cols-[…]` or flex with two children). State: `selectedReplyId` or similar.

- [ ] **Step 2: Conditional layout**

```tsx
import { useIsMobile } from '../hooks/useIsMobile';

// inside component
const isMobile = useIsMobile();

// existing two-pane layout:
//   <div className="grid grid-cols-[320px_1fr] h-[calc(100vh-4rem)]">
//     <ReplyList ... />
//     <ReplyDetail ... />
//   </div>
// becomes:

if (isMobile) {
  if (selectedReplyId) {
    return (
      <div className="min-h-[calc(100vh-3.5rem)] bg-background">
        <div className="sticky top-14 bg-white border-b border-slate-100 px-3 py-2 flex items-center gap-2 z-10">
          <button
            onClick={() => setSelectedReplyId(null)}
            aria-label="Back to inbox"
            className="p-2 -ml-2 text-slate-600"
          >
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <p className="font-bold text-sm truncate">{selectedReply?.company_name ?? 'Reply'}</p>
        </div>
        <ReplyDetail replyId={selectedReplyId} />
      </div>
    );
  }
  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-background">
      <ReplyList onSelect={setSelectedReplyId} />
    </div>
  );
}

// desktop: keep existing two-pane layout unchanged
return (
  <div className="grid grid-cols-[320px_1fr] h-[calc(100vh-4rem)]">
    <ReplyList ... />
    <ReplyDetail ... />
  </div>
);
```

(Substitute the real component names — `ReplyList` / `ReplyDetail` are placeholders. Match what the file actually contains.)

- [ ] **Step 3: Verify type-check**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 4: Manual verification at 375px**

Inbox shows list of replies. Tapping one navigates to a full-screen reading view with a back button. Back button returns to list. At `lg:`, two-pane layout unchanged.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/Inbox.tsx
git commit -m "feat(frontend): inbox uses push-navigation between list and reply on mobile"
```

---

### Task 13: `RedirectedLeads` mobile cards

**Files:**
- Modify: `frontend/src/views/RedirectedLeads.tsx`

- [ ] **Step 1: Inspect**

Read the file. Identify the table and any toolbar.

- [ ] **Step 2: Apply Phase-3 pattern**

Wrap existing `<table>` in `<div className="hidden lg:block">`. Add `<div className="lg:hidden space-y-2 px-3 pb-4">` rendering each row as:

```tsx
<button
  key={lead.id}
  onClick={() => router.push(`/leads/${lead.id}`)}
  className="w-full bg-white rounded-xl border border-slate-100 p-3 text-left active:bg-slate-50"
>
  <div className="flex items-center gap-2 mb-1">
    <p className="font-bold text-sm text-on-surface truncate flex-1">{lead.company_name}</p>
    {lead.star_rating != null && (
      <span className="text-xs text-amber-600 font-bold flex-shrink-0">★ {lead.star_rating.toFixed(1)}</span>
    )}
  </div>
  <div className="flex items-center gap-1.5 text-xs text-secondary">
    <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
    <span className="truncate">{lead.redirected_to_brand ?? lead.redirected_to_url}</span>
  </div>
</button>
```

(Use the actual property names from `types/lead.ts` for redirect target.)

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/views/RedirectedLeads.tsx
git commit -m "feat(frontend): card view for RedirectedLeads below lg"
```

---

### Task 14: `Prospects` mobile cards

**Files:**
- Modify: `frontend/src/views/Prospects.tsx`

- [ ] **Step 1: Inspect**

Read the file. Note the table, any tabs (`Pending` / `Accepted`), any filter row.

- [ ] **Step 2: Apply Phase-3 pattern**

Wrap table in `hidden lg:block`. Add card list:

```tsx
<div className="lg:hidden space-y-2 px-3 pb-4">
  {prospects.map((p) => (
    <div key={p.id} className="bg-white rounded-xl border border-slate-100 p-3">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <p className="font-bold text-sm truncate">{p.company_name}</p>
        <StatusBadge status={p.status} />
      </div>
      {p.discovered_email && (
        <p className="text-xs text-slate-700 truncate mb-2">{p.discovered_email}</p>
      )}
      <div className="flex gap-2">
        {/* mirror desktop row actions: Accept / Reject / View */}
      </div>
    </div>
  ))}
</div>
```

If the page has a top tab bar (Pending / Accepted), make sure it's `flex` and full-width on mobile.

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/views/Prospects.tsx
git commit -m "feat(frontend): card view for Prospects below lg"
```

---

### Task 15: `EmailAccounts` mobile cards

**Files:**
- Modify: `frontend/src/views/EmailAccounts.tsx`

- [ ] **Step 1: Inspect**

Read the file. Identify the account-list table, the DNS badge component (or inline badge JSX), the daily-cap usage indicator, and per-row actions.

- [ ] **Step 2: Apply Phase-3 pattern**

```tsx
<div className="lg:hidden space-y-2 px-3 pb-4">
  {accounts.map((acc) => (
    <div key={acc.id} className="bg-white rounded-xl border border-slate-100 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <p className="font-bold text-sm truncate">{acc.email}</p>
          <p className="text-[11px] text-secondary uppercase tracking-wider">{acc.auth_type}</p>
        </div>
        <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${acc.is_active ? 'bg-[#8ff9a8]/30 text-[#006630]' : 'bg-slate-100 text-slate-500'}`}>
          {acc.is_active ? 'Active' : 'Paused'}
        </span>
      </div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <DnsBadge label="MX"   ok={acc.mx_ok} />
        <DnsBadge label="SPF"  ok={acc.spf_ok} />
        <DnsBadge label="DMARC" ok={acc.dmarc_ok} />
      </div>
      <div className="space-y-1 mb-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-secondary">Daily</span>
          <span className="font-mono">{acc.daily_used}/{acc.daily_cap}</span>
        </div>
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-[#b0004a]"
            style={{ width: `${Math.min(100, (acc.daily_used / acc.daily_cap) * 100)}%` }}
          />
        </div>
      </div>
      <div className="flex gap-2">
        {/* mirror existing per-row actions: Edit / Pause / Disconnect */}
      </div>
    </div>
  ))}
</div>
```

(Use the actual property names — they may be camelCase or snake_case depending on `types/api.ts`. Read `types/api.ts` for the `EmailAccount` interface and use those exact names.)

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/views/EmailAccounts.tsx
git commit -m "feat(frontend): card view for EmailAccounts with DNS + cap usage below lg"
```

---

### Task 16: `WarmupPeers` mobile cards

**Files:**
- Modify: `frontend/src/views/WarmupPeers.tsx`

- [ ] **Step 1: Inspect**

Read the file. Identify the peer list (table or card grid).

- [ ] **Step 2: Apply Phase-3 pattern**

If already a card grid, ensure `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` and that each card is touch-friendly (min height ~80px, primary action button ≥44px).

If a table, wrap in `hidden lg:block` and add card variant rendering peer email + status + last-warmup timestamp.

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/views/WarmupPeers.tsx
git commit -m "feat(frontend): mobile card layout for WarmupPeers"
```

---

### Task 17: `AffiliateMonitor` — `SummaryStats` + tables

**Files:**
- Modify: `frontend/src/components/affiliate-monitor/SummaryStats.tsx`
- Modify: `frontend/src/components/affiliate-monitor/AffiliateTable.tsx`
- Modify: `frontend/src/components/affiliate-monitor/PageChartTable.tsx`
- Modify: `frontend/src/components/affiliate-monitor/CountryOverview.tsx`
- Modify: `frontend/src/components/affiliate-monitor/DashboardToolbar.tsx`

- [ ] **Step 1: `SummaryStats` grid**

Find the stats grid (likely `grid-cols-4`). Change to `grid grid-cols-2 lg:grid-cols-4 gap-3`.

- [ ] **Step 2: `AffiliateTable` card variant**

Apply Phase-3 pattern (`hidden lg:block` on existing table; add card list with country · affiliate name · score · trend arrow).

- [ ] **Step 3: `PageChartTable` card variant**

Same pattern: each row → card with page name, count, sparkline (if a sparkline component already exists, render it; otherwise drop the spark on mobile).

- [ ] **Step 4: `CountryOverview` reflow**

If it uses a wide multi-column layout, change top-level grid to `grid-cols-1 lg:grid-cols-2`.

- [ ] **Step 5: `DashboardToolbar` filters → bottom sheet**

Same pattern as Task 10: replace inline filter row with a "Filters" button below `sm`, all controls inside `MobileBottomSheet`.

- [ ] **Step 6: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/affiliate-monitor/
git commit -m "feat(frontend): mobile reflow for affiliate-monitor stats, tables, and toolbar"
```

---

## Phase 4 — Campaign Wizard

### Task 18: `CampaignWizard` modal full-screen on mobile + sticky footer

**Files:**
- Modify: `frontend/src/components/campaign-wizard/CampaignWizard.tsx`

- [ ] **Step 1: Inspect modal wrapper**

Read the file. Find the outer modal `<div>` — likely something like:

```tsx
<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
  <div className="bg-white rounded-xl w-[920px] max-w-[95vw] max-h-[90vh] overflow-y-auto">
    {/* stepper + steps + footer */}
  </div>
</div>
```

- [ ] **Step 2: Replace with responsive wrapper**

```tsx
<div className="fixed inset-0 bg-black/50 z-50 flex items-stretch lg:items-center justify-center lg:p-6">
  <div className="bg-white w-full lg:w-[920px] lg:max-w-[95vw] lg:max-h-[90vh] flex flex-col lg:rounded-xl overflow-hidden">
    {/* Compact mobile header: Step N of M · label, with close */}
    <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-slate-100 flex-shrink-0">
      <div>
        <p className="text-[11px] uppercase font-bold tracking-wider text-secondary">
          Step {step + 1} of {STEPS.length}
        </p>
        <p className="text-sm font-extrabold text-on-surface">{STEPS[step].label}</p>
      </div>
      <button onClick={onClose} aria-label="Close" className="p-2 -mr-2 text-slate-500">
        <span className="material-symbols-outlined">close</span>
      </button>
    </div>

    {/* Existing desktop stepper */}
    <div className="hidden lg:block">
      {/* keep existing horizontal stepper JSX */}
    </div>

    {/* Step body */}
    <div className="flex-1 overflow-y-auto p-4 lg:p-6 pb-24 lg:pb-6">
      {step === 0 && <WizardStep1Leads ... />}
      {step === 1 && <WizardStep2Sequence ... />}
      {step === 2 && <WizardStep3Options ... />}
      {step === 3 && <WizardStep4Launch ... />}
    </div>

    {/* Footer: sticky on mobile, regular on desktop */}
    <div className="border-t border-slate-100 bg-white px-4 py-3 lg:px-6 lg:py-4 flex items-center justify-between gap-3 mobile-action-bar lg:[padding-bottom:1rem] flex-shrink-0">
      <button
        onClick={() => setStep((s) => Math.max(0, s - 1))}
        disabled={step === 0 || saving}
        className="px-4 py-2.5 text-sm font-bold text-on-surface disabled:opacity-30"
      >
        Back
      </button>
      <button
        onClick={handleNext}
        disabled={saving}
        className="flex-1 lg:flex-none px-6 py-2.5 primary-gradient text-white rounded-lg font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
      >
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        {STEPS[step].next}
      </button>
    </div>
  </div>
</div>
```

(Match the actual prop signatures of the four step components — read them first.)

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
```

Manual: at 375px, open `/campaigns` → New Campaign. Modal fills the screen. Compact header shows step. Footer is sticky. At `lg:`, original layout.

```bash
git add frontend/src/components/campaign-wizard/CampaignWizard.tsx
git commit -m "feat(frontend): wizard goes full-screen with sticky footer below lg"
```

---

### Task 19: `WizardStep1Leads` (or `StepRecipients`) — single-column lead picker

**Files:**
- Modify: `frontend/src/components/campaign-wizard/WizardStep1Leads.tsx`

- [ ] **Step 1: Inspect**

Read the file. Identify: filter row (country/category/maxLeads), the lead grid/list, the manual-emails input.

- [ ] **Step 2: Reflow filter row**

Wrap filter row in `<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">`. Each `<select>` / `<input>` gets `className="w-full ..."`.

- [ ] **Step 3: Reflow lead grid**

Whatever the current grid is (probably `grid-cols-2` or `grid-cols-3`), change top-level to `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2`.

- [ ] **Step 4: Manual emails textarea full-width**

If a separate input + button exists, stack them: `<div className="space-y-2">` with `<textarea className="w-full ..." />` and a full-width "Add" button.

- [ ] **Step 5: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/campaign-wizard/WizardStep1Leads.tsx
git commit -m "feat(frontend): single-column lead picker in wizard step 1 below sm"
```

---

### Task 20: `WizardStep2Sequence` — stack subject/body, collapsible preview

**Files:**
- Modify: `frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx`

- [ ] **Step 1: Inspect**

Read the file. There's likely a 2-column layout (editor on left, screenshot preview on right).

- [ ] **Step 2: Stack the two columns**

Change top-level from `grid-cols-2` (or flex-row) to `grid grid-cols-1 lg:grid-cols-2 gap-4`.

- [ ] **Step 3: Wrap preview in collapsible details on mobile**

If the screenshot preview is a `<div>`, change to:

```tsx
{/* Mobile: collapsible accordion */}
<details className="lg:hidden bg-white rounded-xl border border-slate-100">
  <summary className="px-4 py-3 font-bold text-sm cursor-pointer flex items-center justify-between">
    Preview screenshot
    <span className="material-symbols-outlined text-secondary">expand_more</span>
  </summary>
  <div className="p-3 border-t border-slate-100">
    {/* existing preview JSX */}
  </div>
</details>

{/* Desktop: always-visible side panel */}
<div className="hidden lg:block">
  {/* existing preview JSX */}
</div>
```

- [ ] **Step 4: Toolbar (AI button, spintax, etc.) — wrap**

Whatever toolbar buttons exist above the body editor: `<div className="flex flex-wrap items-center gap-2">`.

- [ ] **Step 5: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx
git commit -m "feat(frontend): stack template editor with collapsible preview below lg"
```

---

### Task 21: `WizardStep3Options` — stacked schedule + follow-ups

**Files:**
- Modify: `frontend/src/components/campaign-wizard/WizardStep3Options.tsx`
- Modify: `frontend/src/components/campaign-wizard/StepSetup.tsx` (if it shares the schedule UI)
- Modify: `frontend/src/components/campaign-wizard/StepFollowUps.tsx` (if it's separately rendered)

- [ ] **Step 1: Inspect**

Read all three files. Identify any `grid-cols-2`/`grid-cols-3` schedule layouts (timezone, start hour, end hour, days, dailyLimit).

- [ ] **Step 2: Reflow schedule**

Change all schedule grids to `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3`. Day-of-week chip row: `flex flex-wrap gap-2`.

- [ ] **Step 3: Follow-up cards stack**

If `StepFollowUps` renders follow-up cards in a horizontal row, change to `space-y-3` (stacked).

- [ ] **Step 4: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/campaign-wizard/WizardStep3Options.tsx frontend/src/components/campaign-wizard/StepSetup.tsx frontend/src/components/campaign-wizard/StepFollowUps.tsx
git commit -m "feat(frontend): single-column schedule and follow-ups in wizard step 3 below sm"
```

---

### Task 22: `WizardStep4Launch` (or `StepReview`) — stacked summary

**Files:**
- Modify: `frontend/src/components/campaign-wizard/WizardStep4Launch.tsx`
- Modify: `frontend/src/components/campaign-wizard/StepReview.tsx` (if separate)

- [ ] **Step 1: Inspect**

Read the file. Identify summary cards (recipients, sender, schedule, template preview).

- [ ] **Step 2: Stack**

Top-level: `grid grid-cols-1 lg:grid-cols-2 gap-4`. Sender-account picker: full-width on mobile.

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/campaign-wizard/WizardStep4Launch.tsx frontend/src/components/campaign-wizard/StepReview.tsx
git commit -m "feat(frontend): stacked launch summary in wizard step 4 below lg"
```

---

## Phase 5 — Modals + forms

### Task 23: Standardize modals to full-screen sheet on mobile

**Files (apply same pattern to each):**
- Modify: `frontend/src/components/TestFlightModal.tsx`
- Modify: `frontend/src/components/SendConfirmModal.tsx`
- Modify: `frontend/src/components/QuickSendModal.tsx`
- Modify: `frontend/src/components/NoteEditor.tsx`
- Modify: `frontend/src/components/FollowUpScheduler.tsx`

- [ ] **Step 1: Pattern**

Each modal currently has an outer wrapper like:

```tsx
<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
  <div className="bg-white rounded-xl w-[480px] max-w-[95vw] p-6">
    ...
  </div>
</div>
```

Change to:

```tsx
<div className="fixed inset-0 bg-black/50 z-50 flex items-stretch lg:items-center justify-center lg:p-6">
  <div className="bg-white w-full lg:w-[480px] lg:max-w-[95vw] flex flex-col lg:rounded-xl overflow-y-auto p-4 lg:p-6">
    ...
  </div>
</div>
```

(Width may differ per modal — preserve the original `lg:w-[…]` value.)

- [ ] **Step 2: Stacked form rows**

Find any `grid-cols-2` form rows inside these modals; change to `grid-cols-1 sm:grid-cols-2`.

- [ ] **Step 3: CTA full-width on mobile**

Primary action button: `className="w-full sm:w-auto …"`.

- [ ] **Step 4: Apply to each of the 5 modals individually, type-check, commit per file**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/TestFlightModal.tsx
git commit -m "feat(frontend): TestFlightModal full-screen on mobile"
# repeat for each modal
```

---

### Task 24: `ScrapeForm` — single-column on mobile

**Files:**
- Modify: `frontend/src/components/ScrapeForm.tsx`

- [ ] **Step 1: Inspect**

Read the file.

- [ ] **Step 2: Reflow**

Outer form: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3`. "Start Scrape" button: `className="sm:col-span-2 lg:col-span-1 w-full sm:w-auto …"`.

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/ScrapeForm.tsx
git commit -m "feat(frontend): single-column scrape form below sm"
```

---

## Phase 6 — Page-specific layouts

### Task 25: `Dashboard` view + `StatsRow`

**Files:**
- Modify: `frontend/src/components/StatsRow.tsx`
- Modify: `frontend/src/views/Dashboard.tsx`

- [ ] **Step 1: `StatsRow` grid**

Find the stat-card grid. Change to `grid grid-cols-2 lg:grid-cols-4 gap-3`.

- [ ] **Step 2: `Dashboard` chart wrappers**

Around any chart container, ensure `min-w-0` and `min-h-[260px]`. Wrap multi-chart sections in `grid grid-cols-1 lg:grid-cols-2 gap-4`.

- [ ] **Step 3: Reduce horizontal padding**

`px-10` → `px-4 lg:px-10` everywhere in Dashboard.

- [ ] **Step 4: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/StatsRow.tsx frontend/src/views/Dashboard.tsx
git commit -m "feat(frontend): dashboard stats and charts reflow below lg"
```

---

### Task 26: `LeadDetail` — tabs on mobile

**Files:**
- Modify: `frontend/src/views/LeadDetail.tsx`

- [ ] **Step 1: Inspect**

Read the file. There's likely a 2-column layout: lead info on left, activity/notes on right.

- [ ] **Step 2: Add tab state**

```tsx
import { useState } from 'react';

const [mobileTab, setMobileTab] = useState<'info' | 'activity' | 'notes'>('info');
```

- [ ] **Step 3: Render mobile tabs above stacked panels**

```tsx
{/* Mobile tab bar */}
<div className="lg:hidden sticky top-14 bg-white border-b border-slate-100 z-10 flex">
  {(['info', 'activity', 'notes'] as const).map((t) => (
    <button
      key={t}
      onClick={() => setMobileTab(t)}
      className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider ${
        mobileTab === t ? 'text-[#b0004a] border-b-2 border-[#b0004a]' : 'text-secondary'
      }`}
    >
      {t}
    </button>
  ))}
</div>

{/* Existing panels: hide on mobile if not the active tab; always show on lg */}
<div className={`${mobileTab === 'info' ? 'block' : 'hidden'} lg:block`}>
  {/* lead info panel */}
</div>
<div className={`${mobileTab === 'activity' ? 'block' : 'hidden'} lg:block`}>
  {/* activity timeline panel */}
</div>
<div className={`${mobileTab === 'notes' ? 'block' : 'hidden'} lg:block`}>
  {/* notes panel */}
</div>
```

Top-level wrapper: change from `grid grid-cols-2` to `grid grid-cols-1 lg:grid-cols-2 gap-4`.

- [ ] **Step 4: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/views/LeadDetail.tsx
git commit -m "feat(frontend): tabs for info/activity/notes on lead detail below lg"
```

---

### Task 27: `Analytics` view — chart reflow

**Files:**
- Modify: `frontend/src/views/Analytics.tsx`

- [ ] **Step 1: Inspect**

Read the file. List every chart container.

- [ ] **Step 2: Reflow**

Top-level chart grid: `grid grid-cols-1 lg:grid-cols-2 gap-4`.

For each Recharts component, add `<div className="min-w-0 min-h-[260px]">` wrapper. Inside `<XAxis>`, set `interval="preserveStartEnd"` and on `< sm`, hide tick labels via:

```tsx
<XAxis
  dataKey="x"
  interval="preserveStartEnd"
  tick={{ fontSize: 10 }}
  hide={false}
/>
```

If a chart still looks bad on 375px (axis labels overlap, legend wraps awkwardly), wrap that specific chart in `hidden sm:block` and add a simplified summary card in `sm:hidden` showing just the headline number(s) — decided per-chart during implementation.

- [ ] **Step 3: Reduce padding**

`px-10` → `px-4 lg:px-10`.

- [ ] **Step 4: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/views/Analytics.tsx
git commit -m "feat(frontend): analytics charts reflow with min-width guard below lg"
```

---

### Task 28: `Campaigns` view + `CampaignCard` + `CampaignDetail`

**Files:**
- Modify: `frontend/src/views/Campaigns.tsx`
- Modify: `frontend/src/components/CampaignCard.tsx`
- Modify: `frontend/src/components/CampaignDetail.tsx`

- [ ] **Step 1: `Campaigns` grid**

Top-level campaign list: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4`.

- [ ] **Step 2: `CampaignCard` touch-friendly**

Ensure card padding ≥ `p-4`, primary CTAs ≥ 44px touch height.

- [ ] **Step 3: `CampaignDetail` tabs**

Same tab pattern as LeadDetail (Task 26): tabs `Overview / Recipients / Stats`. Top-level grid: `grid grid-cols-1 lg:grid-cols-2 gap-4`.

- [ ] **Step 4: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/views/Campaigns.tsx frontend/src/components/CampaignCard.tsx frontend/src/components/CampaignDetail.tsx
git commit -m "feat(frontend): mobile campaign cards and detail tabs below lg"
```

---

### Task 29: `Scrape` view layout

**Files:**
- Modify: `frontend/src/views/Scrape.tsx`

- [ ] **Step 1: Inspect**

Read the file. The Scrape page has the form + a `JobProgress` panel.

- [ ] **Step 2: Stack on mobile**

Top-level: `grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-4`. Form on top on mobile, side-by-side on desktop.

`px-10` → `px-4 lg:px-10`.

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/views/Scrape.tsx
git commit -m "feat(frontend): stack scrape form and progress below lg"
```

---

### Task 30: Sweep remaining views for hard-coded `px-10`/`grid-cols-N`

**Files:**
- Audit: every file under `frontend/src/views/*.tsx`
- Audit: every file under `frontend/src/components/*.tsx` not yet touched

- [ ] **Step 1: Search for hard-coded horizontal padding**

```bash
grep -rn "px-10\|px-12\|px-16" frontend/src --include="*.tsx"
```

For each match, change to the responsive form (`px-4 sm:px-6 lg:px-10`, etc.). Don't touch matches inside Tailwind comments.

- [ ] **Step 2: Search for non-responsive grids**

```bash
grep -rn "grid-cols-[2-6]" frontend/src --include="*.tsx" | grep -v "lg:grid-cols\|md:grid-cols\|sm:grid-cols"
```

For each match, judge by reading the surrounding JSX whether it should reflow. Common fix: prepend the breakpoint (`grid-cols-1 sm:grid-cols-2`).

- [ ] **Step 3: Search for `w-[…px]` widths that exceed 375px**

```bash
grep -rn "w-\[[3-9][0-9][0-9]px\]\|w-\[1[0-9][0-9][0-9]px\]" frontend/src --include="*.tsx"
```

For each match where the element is a top-level container, change to `w-full lg:w-[…]`.

- [ ] **Step 4: Verify + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/
git commit -m "refactor(frontend): sweep hard-coded paddings, widths, and grids for responsive defaults"
```

---

## Phase 7 — Verification + screenshot pass

### Task 31: Full-app type-check + lint

- [ ] **Step 1: Type-check both projects**

```bash
cd frontend && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Lint**

```bash
cd frontend && npm run lint
```

Expected: zero errors. Fix any new lint warnings introduced.

---

### Task 32: Manual flow walkthrough at 375px

Open `npm run dev`, Chrome DevTools → iPhone SE (375×667). Walk these flows. Mark each ✅ or ❌ with notes for any issue.

- [ ] **Flow 1:** Open hamburger → tap each of the 10 nav items → confirm route changes and drawer closes.
- [ ] **Flow 2:** `/leads` → tap Filters → set country → close sheet → confirm list filtered → tap a lead card → land on Lead Detail → tap Activity tab → tap back → confirm scroll position preserved on list.
- [ ] **Flow 3:** `/campaigns` → tap "New Campaign" → wizard fills the screen → step through all 4 steps using the sticky footer → cancel.
- [ ] **Flow 4:** `/campaigns` → existing campaign card → tap Test Flight → modal full-screen → enter test email → confirm.
- [ ] **Flow 5:** `/inbox` → tap a reply → reading view full-screen → back → list preserved.
- [ ] **Flow 6:** `/email-accounts` → tap "Add Account" → Bluehost flow → confirm form is single-column and inputs don't trigger zoom.
- [ ] **Flow 7:** `/analytics` → confirm every chart is readable (no overlap, no horizontal scroll).
- [ ] **Flow 8:** `/affiliate-monitor` → tap Filters → confirm sheet opens with all controls.

If any flow fails, fix the offending file, type-check, commit a `fix(frontend): ...` patch, then re-run that flow.

---

### Task 33: Regression check at 1024px and 1440px

Switch DevTools to "Responsive" → 1024×768, then 1440×900.

- [ ] **Step 1:** Hamburger MUST be hidden. Sidebar fixed at left.
- [ ] **Step 2:** Tables render as tables, not cards.
- [ ] **Step 3:** Modals are centered cards, not full-screen.
- [ ] **Step 4:** Wizard footer is bottom-of-modal, not sticky-to-viewport.
- [ ] **Step 5:** Notification + Help dropdowns float as before.

If any of the above shows mobile behavior at desktop widths, find the offending Tailwind class (likely a missing `lg:`) and fix.

---

### Task 34: Playwright screenshot capture

Use the `webapp-testing` skill to capture screenshots of every page at 375px, 768px, and 1440px. Compare 1440px screenshots against the pre-pass baseline (if available via git history) — there should be no visual regression at desktop widths.

- [ ] **Step 1:** Drive Playwright through `/`, `/scrape`, `/leads`, `/leads/[some-id]`, `/redirected-leads`, `/prospects`, `/inbox`, `/analytics`, `/campaigns`, `/email-accounts`, `/warmup-peers`, `/affiliate-monitor` at each viewport.
- [ ] **Step 2:** Save screenshots under `.tmp/mobile-pass-screenshots/<viewport>/<page>.png`.
- [ ] **Step 3:** Eyeball each set. Note any layout issues, file fix-up commits.

---

### Task 35: Final commit + ready-to-deploy commit message

- [ ] **Step 1: Final type-check + lint**

```bash
cd frontend && npx tsc --noEmit && npm run lint
```

- [ ] **Step 2: Output deploy commands for the user**

Per the user's `CLAUDE.md`: never auto-deploy. Print these for the user to copy:

```bash
git log --oneline origin/main..HEAD   # confirm commit list
git push origin main                    # triggers Vercel deploy
```

(No backend deploy needed — this is frontend-only.)

---

## Self-Review

**Spec coverage check:**

| Spec section | Implementing tasks |
|---|---|
| §2 Breakpoints | Task 1 (hook), Task 4 (CSS guard), every reflow task |
| §3 Shell | Tasks 5, 6, 7, 8 |
| §4 Tables → cards | Tasks 9, 13, 14, 15, 16, 17 |
| §5 Wizard | Tasks 18, 19, 20, 21, 22 |
| §6 Modals & forms | Tasks 23, 24 (and the input-zoom CSS in Task 4) |
| §7 Page-by-page diff | Tasks 11 (pipeline), 12 (inbox), 25 (dashboard), 26 (lead detail), 27 (analytics), 28 (campaigns), 29 (scrape), 30 (sweep) |
| §8 New files | Tasks 1, 2, 3 |
| §9 Testing | Tasks 31, 32, 33, 34 |
| §10 Risks (Recharts) | Task 27 |

No spec section without a task. All identified component files are addressed.

**Placeholder scan:** All "TODO/TBD" inside `<details>` placeholders ("mirror existing per-row actions") are intentional handoffs to the engineer reading the file (the actions vary per page and exist in the file already). Every step has either a code block, an exact command, or a concrete decision to make.

**Type consistency:** `useIsMobile` is defined once in Task 1 and consumed by Tasks 8, 12, 26 (and any later reflow that needs JS-driven branching). `UIContext`'s `drawerOpen` / `toggleDrawer` / `closeDrawer` names are used consistently across Tasks 5, 6, 7. `MobileBottomSheet` props (`open`, `onClose`, `title`, `children`, `maxHeight`) match across Tasks 3, 8, 10, 17.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-mobile-responsive-implementation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — I execute tasks in this session using executing-plans, batching with checkpoints for review.

Which approach?

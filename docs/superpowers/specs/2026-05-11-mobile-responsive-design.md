# Mobile Responsive Pass — Design Spec

**Date:** 2026-05-11
**Owner:** john@optinetsolutions.com
**Status:** approved (brainstorm)
**Scope:** Frontend only (`frontend/`). No backend/API changes.

---

## 1. Goal

Make every page of the Trustpilot Lead Gen / OptiRate dashboard usable and pleasant on a phone (down to 375px wide) without regressing the existing desktop experience.

**User-decided scope:** full app, every page. Tables auto-switch to card lists on mobile. Campaign Wizard fully supported on mobile. Sidebar becomes a hamburger drawer below `lg`.

**Non-goals (explicit):** PWA / installable, offline support, swipe gestures, dark mode, route-shell refactors.

---

## 2. Breakpoints

Use Tailwind defaults — no custom breakpoints.

| Range | Name | Layout |
|---|---|---|
| `< 768px` (no prefix → `md:`) | mobile | drawer sidebar, card lists, stacked forms, full-screen modals |
| `768–1023px` (`md:`) | tablet | drawer sidebar, card lists, 2-col forms, full-screen modals |
| `≥ 1024px` (`lg:`) | desktop | current fixed sidebar, full tables, current layout (no visual regression) |

The mobile↔desktop split is binary at `lg` (1024px). Tablet behaves like mobile for sidebar + tables + modals; it differs from phone only in horizontal density (2-col forms, more cards per row where applicable).

**Floor:** 375px (iPhone SE width).
**Touch targets:** ≥ 44px square.
**Inputs on `< sm`:** `text-base` (16px) to suppress iOS auto-zoom.

A small `useIsMobile()` hook (`< 1024px`, SSR-safe via `useEffect` + `matchMedia`) for the cases where conditional rendering is cleaner than CSS — drawer state, card-vs-table switching, modal full-screen.

---

## 3. Shell

### `AppShell.tsx`
- Replace hardcoded `ml-64 pt-16` on `<main>` with `lg:ml-64 pt-14 lg:pt-16` so content runs full-width below `lg`.
- Add a `UIContext` (or local state lifted into `AppShell`) holding `drawerOpen` + `setDrawerOpen`. `Sidebar` and `TopBar` consume it.

### `Sidebar.tsx`
Same component, two visual modes driven by CSS + a `data-open` attribute:
- `lg:` → existing fixed `w-64` rail (visually unchanged).
- `< lg` → off-canvas drawer:
  - `fixed inset-y-0 left-0 w-72 -translate-x-full data-[open=true]:translate-x-0 transition-transform`
  - Backdrop overlay (`fixed inset-0 bg-black/40`) closes on click.
  - Body scroll lock while open.
  - ESC key closes; nav-item click closes; backdrop click closes.
  - Focus trap inside the drawer while open.
- "New Campaign" CTA, nav items, badges, Settings/Support — all preserved.

### `TopBar.tsx`
- Add hamburger button (`lg:hidden`) on the left of the bar; opens drawer.
- `left-64` becomes `lg:left-64 left-0`. Height `h-14 lg:h-16`.
- Search input collapses to an icon button on `< sm`. Tapping expands a full-width sticky search bar overlay.
- Notifications + Help dropdowns — currently `absolute right-0 top-10 w-80/w-96` — switch to **bottom sheets** on `< sm`: `fixed inset-x-0 bottom-0 max-h-[80vh] rounded-t-2xl`. Above `sm:` they keep current absolute-positioned dropdown.
- "OptiRate / Test Phase" brand block hidden on `< sm`.

---

## 4. Tables → cards

No reusable `<ResponsiveTable>` wrapper — each table has different columns, badges, and actions, and the abstraction would obscure intent. Pattern instead:

```tsx
{/* desktop */}
<div className="hidden lg:block">
  <table>...</table>
</div>

{/* mobile */}
<div className="lg:hidden space-y-2">
  {rows.map(row => <RowCard key={row.id} row={row} />)}
</div>
```

Bulk-select stays as checkboxes on the card. When `selected.length > 0`, a sticky bottom action bar appears (`lg:hidden fixed bottom-0 inset-x-0`) with the same bulk actions the desktop toolbar exposes. Filter/toolbar rows on each table page collapse into a single "Filters" button on `< sm` that opens a bottom sheet with all filter controls.

### Per-page card payloads

| Component | Card shows | Tap target |
|---|---|---|
| `LeadsTable` (Lead Matrix) | Company · star · country · primary email + `VerifyBadge` · status pill | → Lead Detail |
| `RedirectedLeads` | Original company · "→" · redirected brand · star | → Lead Detail |
| `Prospects` | Company · discovered email · status | → Lead Detail |
| `Inbox` row | Sender · subject · 2-line snippet · time · unread dot | → opens reply pane (full-screen on mobile) |
| `EmailAccounts` row | Email · provider badge · DNS badges (M/S/D) · daily-cap usage bar | → expand actions |
| `AffiliateTable` | Country · affiliate name · score · trend arrow | → details |
| `PageChartTable` | Page name · count · spark | → details |

---

## 5. Campaign Wizard

`CampaignWizard.tsx` runs in a modal today. On `< lg`:
- Modal becomes full-screen (`inset-0`, no margin).
- Header: compact stepper `Step 3 of 4 · Options` + close button. Hide horizontal step pills.
- **`WizardStep1Leads`**: country/category filter row wraps; lead grid → single-column cards with checkbox + company + email. Manual-emails textarea full-width.
- **`WizardStep2Sequence`**: subject + body stack vertically; screenshot preview becomes a `<details>` accordion ("Preview screenshot"), closed by default. Spintax/AI toolbar buttons wrap.
- **`WizardStep3Options`**: timezone/start/end/days inputs single-column; follow-up cards stack.
- **`WizardStep4Launch`**: summary cards stack; recipient count + sender-account picker full-width.
- **Sticky bottom action bar** on mobile: `[Back]  [Next →]` always visible, doesn't scroll with content. Replaces the desktop footer that currently sits below the fold on a phone.

`StepSetup.tsx` (existing scheduling UI) gets the same single-column treatment.

---

## 6. Modals & forms

**Rule:** every modal is centered card on `lg`, full-screen sheet on `< lg`.

- `TestFlightModal`, `SendConfirmModal`, `QuickSendModal`, `NoteEditor`, `FollowUpScheduler` → `inset-0` on mobile, current centered layout above `lg:`.
- All inputs: `text-base` on `< sm` (16px) to stop iOS auto-zoom.
- Form rows: drop `grid-cols-2` to `grid-cols-1 sm:grid-cols-2`.
- Toast/notification anchor: top-right on `lg`, top-center on `< sm` (avoids overlapping the hamburger).
- `ScrapeForm`: country/category/rating/limit single-column; "Start Scrape" CTA full-width and sticky to bottom on mobile.

---

## 7. Page-by-page diff

| Page | Changes |
|---|---|
| Dashboard | `StatsRow` → `grid-cols-2 lg:grid-cols-4`; charts get `min-w-0` overflow guard; follow-up cards full-width. |
| Scrape | Form single-column; `JobProgress` panel stacks under form. |
| Leads | Card list + filter sheet (§4). |
| Lead Detail | Info + timeline columns → mobile tabs (`Info` / `Activity` / `Notes`). |
| Redirected Leads | Card list. |
| Prospects | Card list with discovered-email status. |
| Inbox | List-only on mobile; tapping a row pushes a full-screen reply view. |
| Analytics | Chart cards `grid-cols-1 lg:grid-cols-2`; wrappers force `min-h-[260px]` and `min-w-0` so Recharts doesn't blow out. |
| Campaigns | Campaign cards `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`. `CampaignDetail` two-col → stacked + tabs. |
| Email Accounts | Card list, DNS badge row wraps. |
| Warmup Peers | Card list. |
| Affiliate Monitor | `SummaryStats` grid `2/4`; `AffiliateTable` + `PageChartTable` get card view; `DashboardToolbar` collapses controls into a filter sheet. |

---

## 8. New / changed files (surface area)

**New:**
- `frontend/src/hooks/useIsMobile.ts` — SSR-safe `< 1024px` matcher.
- `frontend/src/context/UIContext.tsx` (or extend existing context if appropriate) — drawer state.
- `frontend/src/components/MobileBottomSheet.tsx` — shared bottom-sheet primitive used by TopBar dropdowns + filter sheets.

**Modified (high-traffic):**
- `AppShell`, `Sidebar`, `TopBar`
- `LeadsTable`, `LeadPipeline`, `CampaignDetail`, `CampaignBuilder`, `CampaignCard`
- All `campaign-wizard/*` components
- All views in `frontend/src/views/*`
- Modal components: `TestFlightModal`, `SendConfirmModal`, `QuickSendModal`, `NoteEditor`, `FollowUpScheduler`
- `ScrapeForm`, `JobProgress`, `StatsRow`, `ActivityTimeline`, `LeadLinkWarning`
- `affiliate-monitor/*` components

**Untouched:**
- `frontend/src/app/**/*.tsx` (Next.js route shells — they only render `<View />`).
- API/backend code, types, hooks (no shape changes).
- `globals.css` theme tokens (existing design system stays).

---

## 9. Testing

1. `npx tsc --noEmit` in `frontend/` after each batch of changes — must stay green.
2. Manual viewport matrix: **375px** (iPhone SE), **414px** (iPhone Pro), **768px** (iPad portrait), **1024px** (desktop kicks in here), **1440px** (desktop regression check).
3. Walk these flows on 375px:
   - Open drawer → navigate to Leads → open filter sheet → filter → tap lead → back.
   - Build a campaign end-to-end through the wizard.
   - Run a Test Flight from a campaign card.
   - Read + reply to an inbox message.
   - Connect a Bluehost account from Email Accounts.
4. Use the `webapp-testing` skill (Playwright) to capture screenshots at each breakpoint for a final visual-diff pass.

---

## 10. Risks

- **Recharts on small viewports**: dense X-axis labels overlap. Mitigation per chart: hide axis ticks on `< sm`, shrink font, `interval="preserveStartEnd"`. If still bad, swap to a simplified summary card on mobile (decided per-chart during implementation).
- **`material-symbols-outlined` font weight**: heavy on slow mobile networks. Already loaded site-wide — no regression, just noted.
- **Body scroll lock + iOS Safari**: known to be finicky. Use the standard `overflow:hidden` + `position:fixed` body trick; preserve scroll position on close.
- **Focus trap in drawer**: must release on close so keyboard nav doesn't get stuck. Use a known-good utility (e.g. an existing `useFocusTrap` if present, or roll a small one).

---

## 11. Out of scope (call out, don't do)

- PWA / installable / offline.
- Touch gesture overhauls (swipe-to-archive in inbox, swipe-row-to-act on tables).
- Dark mode.
- Route shell changes in `frontend/src/app/`.
- Backend / API contract changes.
- Visual redesign of desktop layout (this is purely an additive responsive pass).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Lead, LeadStatus, VerificationStatus } from '../types/lead';
import LeadLinkWarning from './LeadLinkWarning';
import LeadsCardList from './LeadsCardList';

function formatScrapedDate(date: Date): string {
  return date.toLocaleDateString();
}

// "not_verified" is a UI-only pseudo-status: the email exists on the lead
// but no verification has ever been run against it. Distinct from "unknown"
// (which means a verifier was run and returned inconclusive).
type DisplayStatus = VerificationStatus | 'not_verified';

// Resolve which status to render for a per-source email column. Older leads
// that were verified before commit 2a600cf only have lead-level
// verification_status set; the per-source columns stayed null. When the
// per-source email matches primary_email, the lead-level verdict applies and
// we use it as a fallback so the badge renders.
function resolveDisplayStatus(
  perSource: VerificationStatus | null | undefined,
  sourceEmail: string | null | undefined,
  lead: Lead
): DisplayStatus | null {
  if (perSource) return perSource;
  if (sourceEmail && sourceEmail === lead.primary_email && lead.verification_status) {
    return lead.verification_status;
  }
  if (sourceEmail) return 'not_verified';
  return null;
}

// Compact tooltip for the verify badge — single line so Chrome's native
// title rendering stays small. The previous multi-line version produced an
// oversized tooltip that obscured nearby rows on hover. Per-stage detail is
// available in Lead Detail; a hovering chip should be a glance, not a wall.
function buildStageTooltip(status: DisplayStatus, lead?: Lead): string {
  const headlines: Record<DisplayStatus, string> = {
    'valid':        'Deliverable',
    'invalid':      'Will bounce — excluded from campaigns',
    'catch-all':    'Domain accepts all mail — mailbox can\'t be proven',
    'unknown':      'Inconclusive',
    'not_verified': 'Not verified yet',
  };
  if (!lead) return headlines[status];

  // Append the most-decisive stage's verdict on the same line — keeps the
  // tooltip useful without expanding it vertically.
  const tail: string[] = [];
  if (lead.verify_smtp_result === '250') tail.push('SMTP 250');
  else if (lead.verify_smtp_result === '550') tail.push('SMTP 550');
  if (lead.verify_zerobounce_result && lead.verify_zerobounce_result !== 'unknown') {
    tail.push(`ZB: ${lead.verify_zerobounce_result}`);
  }
  return tail.length ? `${headlines[status]} (${tail.join(', ')})` : headlines[status];
}

export function VerifyBadge({
  status,
  sourceEmail,
  lead,
}: {
  status: VerificationStatus | null | undefined;
  sourceEmail?: string | null;
  lead: Lead;
}) {
  const effective = resolveDisplayStatus(status, sourceEmail, lead);
  if (!effective) return null;
  const styles: Record<DisplayStatus, { bg: string; fg: string; icon: string; label: string }> = {
    'valid':        { bg: 'bg-green-50',  fg: 'text-green-700',  icon: 'verified',     label: 'verified' },
    'invalid':      { bg: 'bg-red-50',    fg: 'text-red-700',    icon: 'cancel',       label: 'invalid' },
    'catch-all':    { bg: 'bg-amber-50',  fg: 'text-amber-700',  icon: 'help',         label: 'catch-all' },
    'unknown':      { bg: 'bg-slate-50',  fg: 'text-slate-500',  icon: 'help_outline', label: 'unknown' },
    'not_verified': { bg: 'bg-amber-50',  fg: 'text-amber-700',  icon: 'pending',      label: 'not verified' },
  };
  const s = styles[effective];
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[9px] font-bold ${s.bg} ${s.fg} px-1.5 py-0.5 rounded-full w-fit`}
      title={buildStageTooltip(effective, lead)}
    >
      <span className="material-symbols-outlined text-[9px]">{s.icon}</span>{s.label}
    </span>
  );
}

// Extra column slot — used by the Prospects view to append discovery-specific
// columns (discovered_value, discovered_role, verification_status). Kept
// non-reorderable since they're context-specific to the view that adds them.
export interface ExtraColumn {
  key: string;
  label: string;
  render: (lead: Lead) => React.ReactNode;
  sortKey?: string;
}

interface Props {
  leads: Lead[];
  total: number;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onStatusChange: (id: string, status: LeadStatus) => void;
  onDelete: (id: string) => void;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onLeadClick: (id: string) => void;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSortChange: (col: string) => void;
  // Self-healing URL pipeline hooks. Optional so existing callers keep working;
  // when provided, the LeadLinkWarning badge renders inline under the company
  // name with dismiss / edit-url actions. Bulk operations (validate + delete)
  // live in the parent's existing top-right chip group, not here.
  onDismissLinkFlag?: (id: string) => Promise<void> | void;
  onEditLinkUrl?: (id: string, url: string) => Promise<void> | void;
  // Optional context-specific extras — appended after the standard columns.
  // Used by the Prospects view to surface per-discovery fields without
  // forking LeadsTable. Default behaviour (Leads page) passes nothing and
  // gets the unchanged matrix.
  extraColumns?: ExtraColumn[];
  extraRowActions?: (lead: Lead) => React.ReactNode;
  // Suppress specific built-in columns. Used by Prospects to hide TP / Site /
  // Affiliate email columns since the discovered email is the only one that
  // matters there. Drag-reorder still works on the remaining columns; the
  // hidden ones simply never render.
  hideColumns?: ColKey[];
}

type ColKey = 'company' | 'country' | 'category' | 'trustpilot_email' | 'website_email' | 'affiliate_email' | 'rating' | 'tags' | 'claimed' | 'scraped' | 'screenshot' | 'status';

const DEFAULT_COLS: ColKey[] = ['company', 'country', 'category', 'trustpilot_email', 'website_email', 'affiliate_email', 'rating', 'tags', 'claimed', 'scraped', 'screenshot', 'status'];
// Bump on every new column so loadColOrder injects it for existing users.
const COL_STORAGE_KEY = 'leads_col_order_v7';

const COL_LABELS: Record<ColKey, string> = {
  company: 'Company', country: 'Country', category: 'Category',
  trustpilot_email: 'TP Email', website_email: 'Site Email', affiliate_email: 'Affiliate Email',
  rating: 'Rating', tags: 'Tags', claimed: 'Claimed', scraped: 'Scraped',
  screenshot: 'Shot', status: 'Status',
};

function buildScreenshotSrc(path: string): string {
  if (path.startsWith('http')) return path;
  const filename = path.split(/[/\\]/).pop() || '';
  return `/api/screenshots/${filename}`;
}

// Module-scoped preload cache. Calling `new Image().src = url` lets the
// browser fetch and decode in the background; subsequent <img> elements
// pointing at the same URL hit the HTTP cache and render instantly.
// We dedupe so hovering across 50 rows doesn't fire 50 redundant requests.
const preloadedScreenshots = new Set<string>();
function preloadScreenshot(src: string): void {
  if (preloadedScreenshots.has(src)) return;
  preloadedScreenshots.add(src);
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
}

const COL_SORT_KEY: Partial<Record<ColKey, string>> = {
  company: 'company_name',
  category: 'category',
  trustpilot_email: 'trustpilot_email',
  website_email: 'website_email',
  affiliate_email: 'affiliate_email',
  rating: 'star_rating',
  scraped: 'scraped_at',
  status: 'outreach_status',
};

const STATUSES: LeadStatus[] = ['new', 'contacted', 'replied', 'converted', 'lost'];

function loadColOrder(): ColKey[] {
  try {
    const stored = localStorage.getItem(COL_STORAGE_KEY);
    if (stored) {
      const parsed: ColKey[] = JSON.parse(stored);
      const valid = parsed.filter((c) => DEFAULT_COLS.includes(c));
      const missing = DEFAULT_COLS.filter((c) => !valid.includes(c));
      return [...valid, ...missing];
    }
  } catch {}
  return DEFAULT_COLS;
}

export default function LeadsTable({
  leads, total, page, totalPages,
  onPageChange, onStatusChange, onDelete, selectedIds, onSelect, onLeadClick,
  sortBy, sortDir, onSortChange,
  onDismissLinkFlag, onEditLinkUrl,
  extraColumns, extraRowActions, hideColumns,
}: Props) {
  // The persisted order; drag-reorder mutates this and writes to localStorage.
  const [columnOrder, setColumns] = useState<ColKey[]>(loadColOrder);
  // Visible-column projection: order minus any keys the parent asked us to hide.
  // Drag-reorder still operates on columnOrder; hiding from one page (e.g. the
  // Prospects view dropping TP / Site / Affiliate Email) doesn't wipe the
  // user's drag preferences on the regular Leads page.
  const hideSet = useMemo(() => new Set(hideColumns ?? []), [hideColumns]);
  const columns = useMemo(() => columnOrder.filter((c) => !hideSet.has(c)), [columnOrder, hideSet]);
  const [dragOver, setDragOver] = useState<ColKey | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string>('');
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const dragCol = useRef<ColKey | null>(null);

  // Selection state lives in the parent; mirror it as a Set here for O(1)
  // membership checks. This is the single source of truth — pagination no
  // longer drops cross-page selections because nothing local resets here.
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  // The header checkbox must reflect *current page* selection only,
  // otherwise a 25-id page-1 selection makes the page-2 header look
  // checked even though no page-2 row is selected — and clicking it
  // would wipe the page-1 selection.
  const selectedOnPage = leads.reduce((n, l) => (selected.has(l.id) ? n + 1 : n), 0);
  const allOnPageSelected = leads.length > 0 && selectedOnPage === leads.length;
  const someOnPageSelected = selectedOnPage > 0 && selectedOnPage < leads.length;

  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someOnPageSelected;
    }
  }, [someOnPageSelected]);

  // Excel-style scroll: the wrapper is a bounded scroll container so the
  // thead can pin via `position: sticky` relative to it. Arrow keys scroll
  // horizontally (60px per press, page width on PageUp/PageDown) when the
  // wrapper has focus. Home/End jump to the leftmost/rightmost column.
  const scrollRef = useRef<HTMLDivElement>(null);
  const handleScrollKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const step = 60;
    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); el.scrollBy({ left: -step, behavior: 'smooth' }); break;
      case 'ArrowRight': e.preventDefault(); el.scrollBy({ left:  step, behavior: 'smooth' }); break;
      case 'PageUp':     e.preventDefault(); el.scrollBy({ left: -el.clientWidth, behavior: 'smooth' }); break;
      case 'PageDown':   e.preventDefault(); el.scrollBy({ left:  el.clientWidth, behavior: 'smooth' }); break;
      case 'Home':       e.preventDefault(); el.scrollTo({ left: 0,                behavior: 'smooth' }); break;
      case 'End':        e.preventDefault(); el.scrollTo({ left: el.scrollWidth,   behavior: 'smooth' }); break;
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelect([...next]);
  };
  const toggleAll = () => {
    const pageIds = new Set(leads.map((l) => l.id));
    if (allOnPageSelected) {
      // Remove only current-page IDs; preserve selections from other pages.
      onSelect(selectedIds.filter((id) => !pageIds.has(id)));
    } else {
      // Add current-page IDs to whatever was already selected on other pages.
      const next = new Set(selected);
      pageIds.forEach((id) => next.add(id));
      onSelect([...next]);
    }
  };

  const handleDragStart = (col: ColKey, e: React.DragEvent) => {
    dragCol.current = col;
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (col: ColKey, e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(col);
  };
  const handleDrop = (col: ColKey) => {
    const from = dragCol.current;
    if (!from || from === col) { setDragOver(null); return; }
    // Splice against the full columnOrder (not the filtered `columns`) so
    // hidden entries keep their positions for views that don't hide them.
    const next = [...columnOrder];
    next.splice(next.indexOf(from), 1);
    next.splice(next.indexOf(col), 0, from);
    setColumns(next);
    localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(next));
    dragCol.current = null;
    setDragOver(null);
  };
  const handleDragEnd = () => { dragCol.current = null; setDragOver(null); };

  const renderHeader = (col: ColKey) => {
    const sortKey = COL_SORT_KEY[col];
    const active = sortKey && sortBy === sortKey;
    const isDragTarget = dragOver === col;

    return (
      <th
        key={col}
        draggable
        onDragStart={(e) => handleDragStart(col, e)}
        onDragOver={(e) => handleDragOver(col, e)}
        onDrop={() => handleDrop(col)}
        onDragEnd={handleDragEnd}
        className={`text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary select-none cursor-grab whitespace-nowrap ${isDragTarget ? 'bg-[#ffd9de]' : ''}`}
      >
        <span
          className={`inline-flex items-center gap-1 ${sortKey ? 'cursor-pointer hover:text-on-surface' : ''}`}
          onClick={sortKey ? () => onSortChange(sortKey) : undefined}
        >
          {COL_LABELS[col]}
          {sortKey && (
            <span className={`material-symbols-outlined text-[14px] ${active ? 'text-[#b0004a]' : 'text-slate-300'}`}>
              {active ? (sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
            </span>
          )}
        </span>
      </th>
    );
  };

  const renderCell = (col: ColKey, lead: Lead) => {
    switch (col) {
      case 'company':
        return (
          <td key={col} className="px-4 py-3 max-w-[220px]">
            {lead.trustpilot_url ? (
              <a
                href={lead.trustpilot_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="font-bold text-[#b0004a] hover:underline inline-flex items-center gap-1 text-sm leading-tight"
              >
                <span className="truncate max-w-[190px]">{lead.company_name}</span>
                <span className="material-symbols-outlined text-[12px] shrink-0">open_in_new</span>
              </a>
            ) : (
              <span className="font-bold text-on-surface text-sm">{lead.company_name}</span>
            )}
            {lead.website_url && (
              <a
                href={lead.website_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={lead.website_url}
                className="block text-xs text-[#b0004a] underline underline-offset-2 hover:text-[#900040] truncate mt-0.5 max-w-[200px]"
              >
                {lead.website_url
                  .replace(/^https?:\/\//, '')
                  .replace(/^www\./, '')
                  .split('?')[0]
                  .replace(/\/$/, '')
                  .slice(0, 30)}
              </a>
            )}
            {onDismissLinkFlag && onEditLinkUrl && lead.link_status && (lead.link_status === 'FLAGGED_DEAD' || lead.link_status === 'FLAGGED_REMOVED') && (
              <LeadLinkWarning
                lead={lead}
                onDismiss={onDismissLinkFlag}
                onEditUrl={onEditLinkUrl}
              />
            )}
          </td>
        );
      case 'country':
        return <td key={col} className="px-4 py-3 text-sm text-secondary w-16">{lead.country || '—'}</td>;
      case 'category':
        return (
          <td key={col} className="px-4 py-3">
            {lead.category
              ? <span className="text-xs bg-surface-container text-secondary px-2.5 py-1 rounded-full font-semibold whitespace-nowrap">{lead.category.replace(/_/g, ' ')}</span>
              : <span className="text-slate-300 text-xs">—</span>}
          </td>
        );
      case 'trustpilot_email':
        return (
          <td key={col} className="px-4 py-3 min-w-[140px] max-w-[180px]">
            {lead.trustpilot_email ? (
              <div className="flex flex-col gap-1">
                <span className={`inline-flex items-center gap-1 text-xs ${lead.trustpilot_email_status === 'invalid' ? 'text-slate-400 line-through' : 'text-on-surface'}`}>
                  <span className="material-symbols-outlined text-[12px] text-blue-400 shrink-0">alternate_email</span>
                  <span className="truncate">{lead.trustpilot_email}</span>
                </span>
                <VerifyBadge status={lead.trustpilot_email_status} sourceEmail={lead.trustpilot_email} lead={lead} />
              </div>
            ) : (
              <span className="text-slate-300 text-xs">—</span>
            )}
          </td>
        );
      case 'website_email': {
        const hasWebsiteEmail = !!lead.website_email;
        const hasWebsiteUrl = !!lead.website_url;
        return (
          <td key={col} className="px-4 py-3 min-w-[140px] max-w-[180px]">
            {hasWebsiteEmail ? (
              <div className="flex flex-col gap-1">
                <span className={`inline-flex items-center gap-1 text-xs ${lead.website_email_status === 'invalid' ? 'text-slate-400 line-through' : 'text-on-surface'}`}>
                  <span className="material-symbols-outlined text-[12px] text-green-600 shrink-0">language</span>
                  <span className="truncate font-medium">{lead.website_email}</span>
                </span>
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-green-50 text-green-700 px-1.5 py-0.5 rounded-full w-fit">
                    <span className="material-symbols-outlined text-[9px]">language</span>enriched
                  </span>
                  <VerifyBadge status={lead.website_email_status} sourceEmail={lead.website_email} lead={lead} />
                </div>
              </div>
            ) : hasWebsiteUrl ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-slate-400 italic">no email found</span>
                <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full w-fit" title="Run Enrich">
                  <span className="material-symbols-outlined text-[9px]">hourglass_empty</span>not enriched
                </span>
              </div>
            ) : (
              <span className="text-slate-300 text-xs">—</span>
            )}
          </td>
        );
      }
      case 'affiliate_email': {
        const hasAffEmail = !!lead.affiliate_email;
        return (
          <td key={col} className="px-4 py-3 min-w-[140px] max-w-[180px]">
            {hasAffEmail ? (
              <div className="flex flex-col gap-1">
                <span className={`inline-flex items-center gap-1 text-xs ${lead.affiliate_email_status === 'invalid' ? 'text-slate-400 line-through' : 'text-on-surface'}`}>
                  <span className="material-symbols-outlined text-[12px] text-purple-600 shrink-0">group_add</span>
                  <span className="truncate font-medium">{lead.affiliate_email}</span>
                </span>
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded-full w-fit" title="Found on an affiliate / partner page">
                    <span className="material-symbols-outlined text-[9px]">group_add</span>lateral
                  </span>
                  <VerifyBadge status={lead.affiliate_email_status} sourceEmail={lead.affiliate_email} lead={lead} />
                </div>
              </div>
            ) : (
              <span className="text-slate-300 text-xs">—</span>
            )}
          </td>
        );
      }
      case 'rating':
        return (
          <td key={col} className="px-4 py-3 w-16">
            {lead.star_rating != null
              ? <span className="text-sm font-bold text-[#b0004a]">{lead.star_rating.toFixed(1)} ★</span>
              : <span className="text-slate-300 text-sm">—</span>}
          </td>
        );
      case 'tags':
        return (
          <td key={col} className="px-4 py-3">
            <div className="flex flex-wrap gap-1">
              {(lead.tags || []).map((tag) => (
                <span key={tag} className="text-xs bg-[#ffd9de] text-[#b0004a] px-2 py-0.5 rounded-full font-semibold">{tag}</span>
              ))}
            </div>
          </td>
        );
      case 'claimed':
        return (
          <td key={col} className="px-4 py-3">
            {lead.profile_claimed === true ? (
              <span
                className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-green-50 text-green-700 px-1.5 py-0.5 rounded-full w-fit"
                title="Business has claimed and verified this Trustpilot profile"
              >
                <span className="material-symbols-outlined text-[9px]">verified</span>claimed
              </span>
            ) : lead.profile_claimed === false ? (
              <span
                className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-full w-fit"
                title="No business owner has claimed this Trustpilot profile"
              >
                <span className="material-symbols-outlined text-[9px]">person_off</span>unclaimed
              </span>
            ) : (
              <span className="text-slate-300 text-xs">—</span>
            )}
          </td>
        );
      case 'scraped': {
        const date = lead.scraped_at ? new Date(lead.scraped_at) : null;
        return (
          <td key={col} className="px-4 py-3 text-xs text-secondary whitespace-nowrap w-24">
            {date ? (
              <span title={date.toLocaleString()}>{formatScrapedDate(date)}</span>
            ) : (
              <span className="text-slate-300">—</span>
            )}
          </td>
        );
      }
      case 'screenshot': {
        const hasShot = !!lead.screenshot_path;
        const shotSrc = hasShot ? buildScreenshotSrc(lead.screenshot_path as string) : null;
        return (
          <td key={col} className="px-4 py-3 w-12" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              disabled={!hasShot}
              onMouseEnter={() => { if (shotSrc) preloadScreenshot(shotSrc); }}
              onFocus={() => { if (shotSrc) preloadScreenshot(shotSrc); }}
              onClick={() => {
                if (!shotSrc) return;
                setPreviewLoaded(false);
                setPreviewSrc(shotSrc);
                setPreviewName(lead.company_name);
              }}
              title={hasShot ? 'View Trustpilot screenshot' : 'No screenshot captured'}
              className={`p-1 rounded-lg transition-colors ${
                hasShot
                  ? 'text-[#b0004a] hover:bg-[#ffd9de]'
                  : 'text-slate-200 cursor-not-allowed'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">image</span>
            </button>
          </td>
        );
      }
      case 'status':
        return (
          <td key={col} className="px-4 py-3 w-32" onClick={(e) => e.stopPropagation()}>
            <select
              value={lead.outreach_status}
              onChange={(e) => onStatusChange(lead.id, e.target.value as LeadStatus)}
              className="text-xs bg-surface-container rounded-lg px-2 py-1.5 border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none font-semibold w-full"
            >
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </td>
        );
      default:
        return null;
    }
  };

  return (
    <div className="overflow-hidden">
      {/* Desktop table — hidden on mobile.
          overflow-x-auto + overflow-y-clip keeps this as a horizontal-only scroll
          container — `clip` (unlike `visible`) is NOT coerced to `auto`, so the
          wrapper does NOT become a Y scroll context. That lets `sticky top-16`
          on the thead resolve against the page viewport (just below the topbar)
          while the page itself still scrolls down to pagination. */}
      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={handleScrollKey}
        role="region"
        aria-label="Leads table — use arrow keys to scroll horizontally"
        className="hidden lg:block overflow-x-auto overflow-y-clip rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b0004a]/30 scroll-smooth"
      >
        <table className="w-full text-sm">
          <thead className="sticky top-16 z-20 bg-surface-container border-b border-slate-100 shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={toggleAll}
                  className="rounded border-slate-300 w-3.5 h-3.5 accent-[#b0004a]"
                />
              </th>
              {columns.map(renderHeader)}
              {extraColumns?.map((extra) => {
                const active = extra.sortKey && sortBy === extra.sortKey;
                return (
                  <th
                    key={`extra-${extra.key}`}
                    className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary whitespace-nowrap"
                  >
                    <span
                      className={`inline-flex items-center gap-1 ${extra.sortKey ? 'cursor-pointer hover:text-on-surface' : ''}`}
                      onClick={extra.sortKey ? () => onSortChange(extra.sortKey!) : undefined}
                    >
                      {extra.label}
                      {extra.sortKey && (
                        <span className={`material-symbols-outlined text-[14px] ${active ? 'text-[#b0004a]' : 'text-slate-300'}`}>
                          {active ? (sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
              <th className="w-12 px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {leads.map((lead) => (
              <tr
                key={lead.id}
                className="hover:bg-surface-container-low cursor-pointer transition-colors"
                onClick={() => onLeadClick(lead.id)}
              >
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(lead.id)}
                    onChange={() => toggleSelect(lead.id)}
                    className="rounded border-slate-300 w-3.5 h-3.5 accent-[#b0004a]"
                  />
                </td>
                {columns.map((col) => renderCell(col, lead))}
                {extraColumns?.map((extra) => (
                  <td
                    key={`extra-${extra.key}`}
                    className="px-4 py-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {extra.render(lead)}
                  </td>
                ))}
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1 justify-end">
                    {extraRowActions?.(lead)}
                    <button
                      onClick={() => onDelete(lead.id)}
                      className="text-slate-300 hover:text-error p-1 rounded-lg hover:bg-red-50 transition-colors"
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2 + (extraColumns?.length ?? 0)} className="p-12 text-center text-secondary">
                  <span className="material-symbols-outlined text-[32px] text-slate-200 block mb-2">search_off</span>
                  No leads found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile card list — hidden on desktop */}
      <div className="lg:hidden px-3 py-2">
        <LeadsCardList
          leads={leads}
          selectedIds={selectedIds}
          onSelect={onSelect}
          onLeadClick={onLeadClick}
          onStatusChange={onStatusChange}
          onDelete={onDelete}
          onDismissLinkFlag={onDismissLinkFlag}
          onEditLinkUrl={onEditLinkUrl}
          extraColumns={extraColumns}
          extraRowActions={extraRowActions}
        />
      </div>

      {previewSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPreviewSrc(null)}
        >
          <div
            className="bg-white rounded-2xl ambient-shadow max-w-4xl w-full max-h-[90vh] overflow-hidden border border-slate-100 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-surface-container">
              <div className="flex items-center gap-2 min-w-0">
                <span className="material-symbols-outlined text-[18px] text-[#b0004a] shrink-0">screenshot</span>
                <span className="text-sm font-bold text-on-surface truncate">{previewName}</span>
              </div>
              <button
                onClick={() => setPreviewSrc(null)}
                className="text-slate-400 hover:text-on-surface p-1 rounded-lg hover:bg-surface-container-high transition-colors"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <div className="overflow-auto bg-surface-container flex items-center justify-center p-4 relative min-h-[200px]">
              {!previewLoaded && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="w-8 h-8 rounded-full border-2 border-[#ffd9de] border-t-[#b0004a] animate-spin" />
                </div>
              )}
              <img
                src={previewSrc}
                alt={`Trustpilot profile of ${previewName}`}
                decoding="async"
                fetchPriority="high"
                onLoad={() => setPreviewLoaded(true)}
                onError={() => setPreviewLoaded(true)}
                className={`max-w-full max-h-[75vh] object-contain rounded-lg transition-opacity duration-200 ${previewLoaded ? 'opacity-100' : 'opacity-0'}`}
              />
            </div>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-3 sm:px-4 py-3 border-t border-slate-100 bg-surface-container">
          <span className="text-xs font-semibold text-secondary">
            {total} leads total <span className="sm:hidden">· page {page} of {totalPages}</span>
          </span>
          {/* Mobile: prev/next + current/total */}
          <div className="flex sm:hidden items-center justify-between gap-2">
            <button
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page === 1}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg bg-white border border-slate-200 text-secondary disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-[16px]">chevron_left</span>
              Prev
            </button>
            <span className="text-xs font-bold text-on-surface">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg bg-white border border-slate-200 text-secondary disabled:opacity-40"
            >
              Next
              <span className="material-symbols-outlined text-[16px]">chevron_right</span>
            </button>
          </div>
          {/* Desktop: numbered pages */}
          <div className="hidden sm:flex gap-1">
            {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                onClick={() => onPageChange(p)}
                className={`px-2.5 py-1 text-xs rounded-lg font-bold transition-colors ${
                  p === page
                    ? 'primary-gradient text-on-primary'
                    : 'bg-white border border-slate-200 text-secondary hover:bg-surface-container'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

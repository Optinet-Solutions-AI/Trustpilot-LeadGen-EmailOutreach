import { useState, useRef } from 'react';
import type { Lead, LeadStatus, VerificationStatus } from '../types/lead';
import LeadLinkWarning from './LeadLinkWarning';

function formatScrapedDate(date: Date): string {
  return date.toLocaleDateString();
}

// Build a multi-line tooltip showing the stage-by-stage breakdown the
// validator wrote. Lets the user see exactly *which* stage produced the
// verdict ("SMTP RCPT-TO 250 from mail.bluehost.com" vs "ZeroBounce: catch-all").
function buildStageTooltip(status: VerificationStatus, lead?: Lead): string {
  const headlines: Record<VerificationStatus, string> = {
    'valid':     'Deliverable — safe to send',
    'invalid':   'Will bounce — excluded from campaigns',
    'catch-all': 'Domain accepts all mail — individual mailbox can\'t be proven',
    'unknown':   'Inconclusive — couldn\'t prove either way',
  };
  if (!lead) return headlines[status];

  const lines: string[] = [headlines[status]];
  const breakdown: string[] = [];
  if (lead.verify_syntax_ok === false) breakdown.push('Syntax: failed');
  else if (lead.verify_syntax_ok === true) breakdown.push('Syntax: ok');

  if (lead.verify_mx_ok === false) breakdown.push('MX: not found');
  else if (lead.verify_mx_ok === true) breakdown.push('MX: ok');

  if (lead.verify_smtp_result) {
    const labels: Record<string, string> = {
      '250': 'SMTP probe: 250 (mailbox accepted)',
      '550': 'SMTP probe: 550 (mailbox rejected)',
      'unknown': 'SMTP probe: ambiguous',
      'skipped_catchall': 'SMTP probe: skipped (catch-all domain)',
      'skipped_giant': 'SMTP probe: skipped (Gmail/Outlook365 always 250)',
      'skipped_no_mx': 'SMTP probe: skipped (no MX)',
      'error': 'SMTP probe: connect error',
    };
    breakdown.push(labels[lead.verify_smtp_result] || `SMTP probe: ${lead.verify_smtp_result}`);
  }
  if (lead.verify_zerobounce_result) breakdown.push(`ZeroBounce: ${lead.verify_zerobounce_result}`);

  if (breakdown.length) {
    lines.push('—');
    lines.push(...breakdown);
  }
  if (lead.verified_at) {
    lines.push(`Verified ${new Date(lead.verified_at).toLocaleDateString()}`);
  }
  return lines.join('\n');
}

function VerifyBadge({ status, lead }: { status: VerificationStatus | null | undefined; lead?: Lead }) {
  if (!status) return null;
  const styles: Record<VerificationStatus, { bg: string; fg: string; icon: string; label: string }> = {
    'valid':     { bg: 'bg-green-50',  fg: 'text-green-700',  icon: 'verified',          label: 'valid' },
    'invalid':   { bg: 'bg-red-50',    fg: 'text-red-700',    icon: 'cancel',            label: 'invalid' },
    'catch-all': { bg: 'bg-amber-50',  fg: 'text-amber-700',  icon: 'help',              label: 'catch-all' },
    'unknown':   { bg: 'bg-slate-50',  fg: 'text-slate-500',  icon: 'help_outline',      label: 'unknown' },
  };
  const s = styles[status];
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[9px] font-bold ${s.bg} ${s.fg} px-1.5 py-0.5 rounded-full w-fit`}
      title={buildStageTooltip(status, lead)}
    >
      <span className="material-symbols-outlined text-[9px]">{s.icon}</span>{s.label}
    </span>
  );
}

interface Props {
  leads: Lead[];
  total: number;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onStatusChange: (id: string, status: LeadStatus) => void;
  onDelete: (id: string) => void;
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
  onPageChange, onStatusChange, onDelete, onSelect, onLeadClick,
  sortBy, sortDir, onSortChange,
  onDismissLinkFlag, onEditLinkUrl,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [columns, setColumns] = useState<ColKey[]>(loadColOrder);
  const [dragOver, setDragOver] = useState<ColKey | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string>('');
  const dragCol = useRef<ColKey | null>(null);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
    onSelect([...next]);
  };
  const toggleAll = () => {
    if (selected.size === leads.length) {
      setSelected(new Set()); onSelect([]);
    } else {
      const all = new Set(leads.map((l) => l.id));
      setSelected(all); onSelect([...all]);
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
    const next = [...columns];
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
                <VerifyBadge status={lead.trustpilot_email_status} lead={lead} />
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
                  <VerifyBadge status={lead.website_email_status} lead={lead} />
                </div>
              </div>
            ) : hasWebsiteUrl ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-slate-400 italic">no email found</span>
                <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full w-fit" title="Has website but no email found yet — run Enrich">
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
                  <VerifyBadge status={lead.affiliate_email_status} lead={lead} />
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
        return (
          <td key={col} className="px-4 py-3 w-12" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              disabled={!hasShot}
              onClick={() => {
                if (!hasShot) return;
                setPreviewSrc(buildScreenshotSrc(lead.screenshot_path as string));
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
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-container border-b border-slate-100">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={selected.size === leads.length && leads.length > 0}
                  onChange={toggleAll}
                  className="rounded border-slate-300 w-3.5 h-3.5 accent-[#b0004a]"
                />
              </th>
              {columns.map(renderHeader)}
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
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => onDelete(lead.id)}
                    className="text-slate-300 hover:text-error p-1 rounded-lg hover:bg-red-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} className="p-12 text-center text-secondary">
                  <span className="material-symbols-outlined text-[32px] text-slate-200 block mb-2">search_off</span>
                  No leads found
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
            <div className="overflow-auto bg-surface-container flex items-center justify-center p-4">
              <img
                src={previewSrc}
                alt={`Trustpilot profile of ${previewName}`}
                className="max-w-full max-h-[75vh] object-contain rounded-lg"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 bg-surface-container">
          <span className="text-xs font-semibold text-secondary">{total} leads total</span>
          <div className="flex gap-1">
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

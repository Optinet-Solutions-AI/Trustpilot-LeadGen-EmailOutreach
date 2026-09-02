import type { Lead, LeadStatus } from '../types/lead';
import { VerifyBadge, type ExtraColumn } from './LeadsTable';
import StatusBadge from './StatusBadge';
import LeadLinkWarning from './LeadLinkWarning';

interface Props {
  leads: Lead[];
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  /** Mirrors LeadsTable's prop of the same name — see the note there. */
  isSelectable?: (lead: Lead) => boolean;
  onLeadClick: (id: string) => void;
  onStatusChange?: (id: string, status: LeadStatus) => void;
  onDelete?: (id: string) => void;
  onDismissLinkFlag?: (id: string) => Promise<void> | void;
  onEditLinkUrl?: (id: string, url: string) => Promise<void> | void;
  extraColumns?: ExtraColumn[];
  extraRowActions?: (lead: Lead) => React.ReactNode;
}

/**
 * Mobile card variant of LeadsTable. Renders one card per lead with the
 * fields that matter most on a phone: company, rating, primary email +
 * verify badge, outreach status. The desktop table (LeadsTable) handles
 * column reordering, screenshot preview, drag/drop, and the wide column
 * set — none of that fits on a 375px screen.
 */
export default function LeadsCardList({
  leads,
  selectedIds,
  onSelect,
  isSelectable: isSelectableOverride,
  onLeadClick,
  onDismissLinkFlag,
  onEditLinkUrl,
  extraColumns,
  extraRowActions,
}: Props) {
  const selected = new Set(selectedIds);
  // Mirrors LeadsTable: a proven-invalid address can never be emailed, so it
  // is never selectable. Both list renderers must agree or the rule is only
  // as strong as the viewport width.
  const isSelectable = isSelectableOverride ?? ((l: Lead) => l.verification_status !== 'invalid');
  const selectableOnPage = leads.filter(isSelectable);
  const toggleSelect = (id: string) => {
    const lead = leads.find((l) => l.id === id);
    if (lead && !isSelectable(lead)) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelect([...next]);
  };

  // Page-scoped select-all: matches LeadsTable's desktop header checkbox so
  // mobile users have the same bulk-select affordance. Toggles only the
  // current page's ids, preserving any selections on other pages.
  const selectedOnPage = selectableOnPage.reduce((n, l) => (selected.has(l.id) ? n + 1 : n), 0);
  const allOnPageSelected = selectableOnPage.length > 0 && selectedOnPage === selectableOnPage.length;
  const toggleAllOnPage = () => {
    const pageIds = new Set(selectableOnPage.map((l) => l.id));
    if (allOnPageSelected) {
      onSelect(selectedIds.filter((id) => !pageIds.has(id)));
    } else {
      const next = new Set(selected);
      pageIds.forEach((id) => next.add(id));
      onSelect([...next]);
    }
  };

  if (leads.length === 0) {
    return (
      <div className="text-center py-12 text-secondary text-sm">
        No leads match these filters.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Select-all bar — page-scoped, matches desktop header checkbox */}
      <div className="flex items-center justify-between bg-white rounded-lg border border-slate-100 px-3 py-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={allOnPageSelected}
            onChange={toggleAllOnPage}
            className="w-5 h-5 accent-[#b0004a]"
            aria-label={allOnPageSelected ? 'Deselect all on this page' : 'Select all on this page'}
          />
          <span className="text-xs font-bold text-on-surface">
            {allOnPageSelected ? 'Deselect all' : 'Select all on page'}
          </span>
        </label>
        <span className="text-[11px] font-semibold text-secondary">
          {selectedOnPage} / {leads.length}
        </span>
      </div>

      {leads.map((lead) => {
        const isChecked = selected.has(lead.id);
        const emailToShow =
          lead.primary_email ?? lead.trustpilot_email ?? lead.website_email ?? lead.affiliate_email;
        const emailStatus =
          lead.primary_email
            ? lead.verification_status
            : lead.trustpilot_email
              ? lead.trustpilot_email_status
              : lead.website_email
                ? lead.website_email_status
                : lead.affiliate_email_status;
        const linkFlagged =
          lead.link_status === 'FLAGGED_DEAD' || lead.link_status === 'FLAGGED_REMOVED';

        return (
          <div
            key={lead.id}
            onClick={() => onLeadClick(lead.id)}
            className="bg-white rounded-xl border border-slate-100 p-3 flex gap-3 active:bg-slate-50 cursor-pointer"
          >
            <label
              className="flex items-start pt-1"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={isChecked}
                disabled={!isSelectable(lead)}
                onChange={() => toggleSelect(lead.id)}
                title={isSelectable(lead)
                  ? undefined
                  : 'Email verified as invalid — campaigns cannot send to this address.'}
                className="w-5 h-5 accent-[#b0004a] disabled:opacity-30"
                aria-label={`Select ${lead.company_name}`}
              />
            </label>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2 mb-1">
                <p className="font-bold text-sm text-on-surface truncate">
                  {lead.company_name}
                </p>
                {lead.star_rating != null && (
                  <span className="flex-shrink-0 text-xs text-amber-600 font-bold">
                    ★ {lead.star_rating.toFixed(1)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-secondary mb-1.5">
                {lead.country && <span>{lead.country}</span>}
                {lead.category && (
                  <span className="truncate">· {lead.category.replace(/_/g, ' ')}</span>
                )}
              </div>
              {emailToShow && (
                <div className="flex items-center gap-2 mb-1.5 min-w-0">
                  <p className="text-xs text-slate-700 truncate flex-1">{emailToShow}</p>
                  <VerifyBadge status={emailStatus} sourceEmail={emailToShow} lead={lead} />
                </div>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={lead.outreach_status} />
                {linkFlagged && onDismissLinkFlag && onEditLinkUrl && (
                  <LeadLinkWarning
                    lead={lead}
                    onDismiss={onDismissLinkFlag}
                    onEditUrl={onEditLinkUrl}
                  />
                )}
              </div>
              {extraColumns && extraColumns.length > 0 && (
                <div className="mt-2 pt-2 border-t border-slate-100 grid grid-cols-2 gap-1 text-[11px]">
                  {extraColumns.map((col) => (
                    <div key={col.key} className="min-w-0">
                      <p className="text-secondary uppercase tracking-wider text-[9px] font-bold">
                        {col.label}
                      </p>
                      <div className="truncate">{col.render(lead)}</div>
                    </div>
                  ))}
                </div>
              )}
              {extraRowActions && (
                <div
                  className="mt-2 pt-2 border-t border-slate-100 flex gap-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  {extraRowActions(lead)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

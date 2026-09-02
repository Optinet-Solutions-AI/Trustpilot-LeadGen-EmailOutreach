import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import api from '../../api/client';

interface PickerLead {
  id: string;
  company_name: string;
  primary_email: string | null;
  star_rating: number | null;
  outreach_status: string;
  verification_status: 'valid' | 'invalid' | 'catch-all' | 'unknown' | null;
}

interface Props {
  filterCountry: string;
  filterCategory: string;
  selectedLeadIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

const LIMIT = 50;
type SortDir = 'asc' | 'desc';

export default function StepRecipients({ filterCountry, filterCategory, selectedLeadIds, onSelectionChange }: Props) {
  const [leads, setLeads] = useState<PickerLead[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState('star_rating');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Global "already contacted" set — emails previously sent/opened/replied/
  // auto_replied/bounced in ANY campaign. Lowercased server-side. Used to
  // badge rows in this picker and exclude them from bulk-select. The server
  // also dedupes at insert and send time as belt-and-suspenders.
  // Language filter — lets one campaign cover every market that shares a
  // language (Italian = IT + CH, English = US/GB/CA/AU/IE/...) instead of
  // forcing one country per campaign. Options come from the API with live
  // counts; the language -> countries expansion happens server-side, so the
  // picker only ever sends a language name.
  const [language, setLanguage] = useState('');
  const onLanguageChange = (v: string) => { setLanguage(v); setPage(1); };
  const [languageOptions, setLanguageOptions] = useState<
    Array<{ language: string; countries: string[]; leadCount: number }>
  >([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/leads/languages');
        if (!cancelled) setLanguageOptions(res.data?.data || []);
      } catch {
        // Non-fatal: the dropdown just stays empty and country filtering
        // behaves as before.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [contactedEmails, setContactedEmails] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/campaigns/sent-emails');
        if (!cancelled) {
          const arr: string[] = res.data?.data || [];
          setContactedEmails(new Set(arr));
        }
      } catch {
        // Non-fatal — picker still works without the badge.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const toggleSort = (col: string) => {
    if (col === sortBy) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('asc'); }
    setPage(1);
  };

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      // A chosen language supersedes the wizard's single country: the point is
      // to reach every market speaking it.
      if (language) params.set('language', language);
      else if (filterCountry) params.set('country', filterCountry);
      if (filterCategory) params.set('category', filterCategory);
      if (debouncedSearch) params.set('search', debouncedSearch);
      params.set('page', String(page));
      params.set('limit', String(LIMIT));
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);
      // Never offer a lead that was already emailed — it could only land as
      // 'skipped'. Done server-side so `total` and the page count stay exact.
      params.set('excludeContacted', 'true');
      const res = await api.get(`/leads?${params}`);
      setLeads(res.data.data);
      setTotal(res.data.total);
      setTotalPages(res.data.totalPages);
    } catch {
      setLeads([]); setTotal(0); setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [language, filterCountry, filterCategory, debouncedSearch, page, sortBy, sortDir]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  // Track per-row re-verify-in-flight state. Clicking an `invalid` lead now
  // triggers ZeroBounce on both source emails and replaces the row with the
  // freshened verdict. The send-gate at /api/campaigns/:id/send still blocks
  // anything that comes back invalid after the refresh.
  const [reverifying, setReverifying] = useState<Set<string>>(new Set());
  const isInvalid = (l: PickerLead) => l.verification_status === 'invalid';
  const isAlreadyContacted = (l: PickerLead) =>
    l.primary_email != null && contactedEmails.has(l.primary_email.toLowerCase());

  // The server already dropped every lead with a send of its own
  // (?excludeContacted=true, an anti-join on campaign_leads.lead_id). This
  // second pass catches the remainder: a DUPLICATE lead row whose address was
  // emailed under a different lead_id, which the lead_id join can't see.
  // ~46 rows today, so pages occasionally render slightly short of LIMIT —
  // preferable to offering someone who can only come back 'skipped'.
  const visibleLeads = leads.filter((l) => !isAlreadyContacted(l));

  const reverifyLead = async (id: string) => {
    setReverifying((prev) => { const n = new Set(prev); n.add(id); return n; });
    try {
      const res = await api.post('/verify/sync', { leadIds: [id] });
      const updated = res.data?.data?.[0];
      if (updated) {
        setLeads((prev) => prev.map((l) => l.id === id ? { ...l, ...updated } : l));
        if (updated.verification_status !== 'invalid' && !selectedLeadIds.includes(id)) {
          onSelectionChange([...selectedLeadIds, id]);
        }
      }
    } catch {
      // Swallow — row stays as-is and user can retry.
    } finally {
      setReverifying((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  const toggleLead = (id: string) => {
    const lead = leads.find((l) => l.id === id);
    if (!lead) return;
    if (isInvalid(lead)) {
      if (reverifying.has(id)) return;
      void reverifyLead(id);
      return;
    }
    if (selectedLeadIds.includes(id)) onSelectionChange(selectedLeadIds.filter((x) => x !== id));
    else onSelectionChange([...selectedLeadIds, id]);
  };

  // "Select page" only auto-adds leads with verification_status === 'valid'.
  // Everything else (invalid, catch-all, unknown, not-yet-verified) requires
  // a deliberate row click. Reasoning:
  //   - invalid: would bounce; bulk-reverify is too credit-hungry.
  //   - catch-all: domain accepts any address; spam-trap risk.
  //   - unknown: verifier returned inconclusive; treat as risky.
  //   - null (not verified): never run through verify; sending blind risks
  //     bouncing on dead addresses and burning sender reputation.
  //   - already contacted in another campaign: server will mark as 'skipped'
  //     at send time; bulk-adding them just clutters the campaign with
  //     dedup-victim rows.
  // Manual click on any row still works as a conscious override.
  const pageIds = visibleLeads
    .filter((l) => l.verification_status === 'valid')
    .map((l) => l.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedLeadIds.includes(id));

  const togglePage = () => {
    if (allPageSelected) onSelectionChange(selectedLeadIds.filter((id) => !pageIds.includes(id)));
    else onSelectionChange([...selectedLeadIds, ...pageIds.filter((id) => !selectedLeadIds.includes(id))]);
  };

  // "Select all valid" — pulls every valid-status lead across all pages
  // matching the current country/category/search filters via the dedicated
  // /api/leads/ids endpoint. Capped at 5000 server-side. Catch-all/invalid/
  // unknown are excluded for the same sender-reputation reasons as
  // "Select page" above. Already-contacted leads are also stripped here so
  // the bulk-add doesn't immediately pile up dedup-victims in the campaign.
  const [selectingAll, setSelectingAll] = useState(false);
  const selectAllValid = async () => {
    setSelectingAll(true);
    try {
      const params = new URLSearchParams();
      // A chosen language supersedes the wizard's single country: the point is
      // to reach every market speaking it.
      if (language) params.set('language', language);
      else if (filterCountry) params.set('country', filterCountry);
      if (filterCategory) params.set('category', filterCategory);
      if (debouncedSearch) params.set('search', debouncedSearch);
      params.set('verificationStatus', 'valid');
      params.set('excludeContacted', 'true');
      const res = await api.get(`/leads/ids?${params}`);
      const rows: Array<{ id: string; primary_email: string | null }> = res.data?.data || [];
      const ids = rows
        .filter((r) => r.primary_email == null || !contactedEmails.has(r.primary_email.toLowerCase()))
        .map((r) => r.id);
      const merged = Array.from(new Set([...selectedLeadIds, ...ids]));
      onSelectionChange(merged);
    } catch {
      // Swallow — selection unchanged on error
    } finally {
      setSelectingAll(false);
    }
  };

  const SortIcon = ({ col }: { col: string }) => (
    <span className={`material-symbols-outlined text-[13px] ml-0.5 ${sortBy === col ? 'text-[#b0004a]' : 'text-slate-300'}`}>
      {sortBy === col ? (sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
    </span>
  );

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h3
            className="text-xl font-extrabold text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Select Recipients
          </h3>
          <p className="text-sm text-secondary mt-0.5">Choose which leads to include. Click headers to sort.</p>
        </div>
        {selectedLeadIds.length > 0 && (
          <div className="flex items-center gap-2 bg-[#ffd9de] rounded-xl px-3 py-2">
            <span className="material-symbols-outlined text-[#b0004a] text-[16px]">group</span>
            <span className="text-sm font-extrabold text-[#b0004a]" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {selectedLeadIds.length} selected
            </span>
          </div>
        )}
      </div>

      {/* Search + actions */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-secondary text-[18px]">search</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search companies..."
            className="w-full bg-surface-container rounded-xl pl-10 pr-4 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
          />
        </div>
        <select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value)}
          title="Target every market that shares a language"
          className="bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none max-w-[210px]"
        >
          <option value="">All languages</option>
          {languageOptions.map((o) => (
            <option key={o.language} value={o.language}>
              {o.language} ({o.leadCount})
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          {visibleLeads.length > 0 && (
            <button
              onClick={togglePage}
              className="text-xs font-bold text-[#b0004a] hover:text-[#7a0033] whitespace-nowrap bg-[#ffd9de] px-3 py-2 rounded-lg transition-colors"
            >
              {allPageSelected ? 'Deselect page' : 'Select page'}
            </button>
          )}
          {visibleLeads.length > 0 && total > LIMIT && (
            <button
              onClick={selectAllValid}
              disabled={selectingAll}
              className="text-xs font-bold text-white whitespace-nowrap bg-[#b0004a] hover:bg-[#7a0033] disabled:opacity-60 px-3 py-2 rounded-lg transition-colors inline-flex items-center gap-1.5"
              title="Select every valid-verified lead across all pages matching the current filters"
            >
              {selectingAll ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> Selecting…
                </>
              ) : (
                'Select all valid (all pages)'
              )}
            </button>
          )}
          {selectedLeadIds.length > 0 && (
            <button
              onClick={() => onSelectionChange([])}
              className="text-xs font-bold text-error hover:text-red-700 whitespace-nowrap bg-red-50 px-3 py-2 rounded-lg transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
      {language && (
        <p className="text-[11px] text-secondary -mt-1">
          Showing <strong>{language}</strong>-speaking markets
          {(() => {
            const o = languageOptions.find((x) => x.language === language);
            return o ? ` (${o.countries.join(", ")})` : "";
          })()}
          {filterCountry ? ` — overrides the ${filterCountry} country filter.` : "."}
        </p>
      )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-secondary gap-2">
          <Loader2 size={16} className="animate-spin text-[#b0004a]" /> Loading leads...
        </div>
      ) : (
        <div className="bg-surface-container-lowest rounded-xl border border-slate-100 overflow-hidden ambient-shadow">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container border-b border-slate-100 text-left">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={togglePage}
                    className="rounded border-slate-300 w-3.5 h-3.5 accent-[#b0004a]"
                  />
                </th>
                <th
                  className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary cursor-pointer hover:text-on-surface select-none"
                  onClick={() => toggleSort('company_name')}
                >
                  Company <SortIcon col="company_name" />
                </th>
                <th
                  className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary cursor-pointer hover:text-on-surface select-none"
                  onClick={() => toggleSort('primary_email')}
                >
                  Email <SortIcon col="primary_email" />
                </th>
                <th
                  className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary cursor-pointer hover:text-on-surface select-none text-right w-20"
                  onClick={() => toggleSort('star_rating')}
                >
                  Rating <SortIcon col="star_rating" />
                </th>
                <th className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-secondary w-24">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {visibleLeads.map((lead) => {
                const isSelected = selectedLeadIds.includes(lead.id);
                const blocked = isInvalid(lead);
                const isReverifying = reverifying.has(lead.id);
                const isCatchAll = lead.verification_status === 'catch-all';
                const isUnknown = lead.verification_status === 'unknown';
                const isNotVerified = lead.verification_status == null;
                const alreadyContacted = isAlreadyContacted(lead);
                const rowTitle = blocked
                  ? 'Click to re-verify with ZeroBounce. If both addresses still fail, the row stays blocked.'
                  : alreadyContacted
                    ? "This email was already sent in another campaign. Adding it anyway will land as 'Skipped'."
                    : undefined;
                return (
                  <tr
                    key={lead.id}
                    className={`transition-colors ${
                      blocked
                        ? `bg-red-50/30 ${isReverifying ? 'cursor-wait' : 'cursor-pointer hover:bg-red-50/50'}`
                        : isSelected
                          ? 'bg-[#ffd9de]/30 hover:bg-[#ffd9de]/50 cursor-pointer'
                          : alreadyContacted
                            ? 'bg-orange-50/30 hover:bg-orange-50/50 cursor-pointer'
                            : 'hover:bg-surface-container-low cursor-pointer'
                    }`}
                    onClick={() => toggleLead(lead.id)}
                    title={rowTitle}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      {isReverifying ? (
                        <Loader2 size={14} className="animate-spin text-[#b0004a]" />
                      ) : (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleLead(lead.id)}
                          className="rounded border-slate-300 w-3.5 h-3.5 accent-[#b0004a]"
                        />
                      )}
                    </td>
                    <td className="px-4 py-3 font-bold text-on-surface">{lead.company_name}</td>
                    <td className="px-4 py-3 text-xs">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-secondary ${blocked ? 'line-through text-slate-400' : ''}`}>
                          {lead.primary_email || <span className="text-slate-300">—</span>}
                        </span>
                        {blocked && !isReverifying && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-red-50 text-red-700 px-1.5 py-0.5 rounded-full" title="Will bounce — click row to re-verify">
                            <span className="material-symbols-outlined text-[9px]">cancel</span>invalid
                          </span>
                        )}
                        {isReverifying && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-full">
                            <Loader2 size={9} className="animate-spin" />re-verifying
                          </span>
                        )}
                        {isCatchAll && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full" title="Domain accepts all mail — individual mailbox can't be proven. Not added by 'Select page'; click the row to include manually.">
                            <span className="material-symbols-outlined text-[9px]">help</span>catch-all
                          </span>
                        )}
                        {isUnknown && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-slate-50 text-slate-500 px-1.5 py-0.5 rounded-full" title="Verification was inconclusive. Not added by 'Select page'; click the row to include manually.">
                            <span className="material-symbols-outlined text-[9px]">help_outline</span>unknown
                          </span>
                        )}
                        {isNotVerified && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full" title="Not verified yet. Not added by 'Select page'; click the row to include manually, or run Verify on the Leads page first.">
                            <span className="material-symbols-outlined text-[9px]">pending</span>not verified
                          </span>
                        )}
                        {alreadyContacted && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-orange-50 text-orange-700 px-1.5 py-0.5 rounded-full" title="This email was already sent in another campaign. Not added by 'Select page'; clicking the row anyway will land as 'Skipped' at send time.">
                            <span className="material-symbols-outlined text-[9px]">block</span>contacted elsewhere
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-[#b0004a] text-xs">
                      {lead.star_rating != null ? `${lead.star_rating} ★` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className="bg-surface-container text-secondary px-2 py-0.5 rounded-full font-semibold capitalize">
                        {lead.outreach_status}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {visibleLeads.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-secondary">
                    <span className="material-symbols-outlined text-[28px] text-slate-200 block mb-1">search_off</span>
                    No leads found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-secondary font-semibold">
            Showing {((page - 1) * LIMIT) + 1}–{Math.min(page * LIMIT, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
              className="p-2 rounded-lg bg-surface-container disabled:opacity-40 hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">chevron_left</span>
            </button>
            <span className="px-3 font-semibold text-secondary">Page {page} of {totalPages}</span>
            <button
              disabled={page === totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="p-2 rounded-lg bg-surface-container disabled:opacity-40 hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">chevron_right</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

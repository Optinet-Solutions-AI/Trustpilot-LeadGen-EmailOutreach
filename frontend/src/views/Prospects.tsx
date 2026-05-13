'use client';

/**
 * Prospects — single-page list of leads the system or user has flagged as
 * worth pursuing further. One row per lead, surfaced from the
 * discovered_contacts queue (auto-detected on incoming auto-replies AND
 * manually promoted from the Inbox).
 *
 * The TP / Site / Affiliate email columns are deliberately hidden — those
 * were the original cold-target addresses and don't matter once we're
 * targeting a discovered contact. Instead the row shows the **Discovered
 * Email** (the new contact we extracted or scraped) plus its verification
 * status, the source campaign, and per-row actions.
 *
 * Per-lead aggregation: a single lead can have multiple discovered_contacts
 * rows (e.g. extractor pulled 3 candidate emails from one auto-reply, plus
 * a URL whose scrape harvested 2 more). The Prospects view collapses these
 * to one row per lead and surfaces the **best** candidate — accepted first,
 * then highest-score pending, with the rest accessible via Lead Detail.
 *
 * No tabs. No sub-funnels. The user wants a clean prospect queue.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import api from '../api/client';
import LeadsTable, { type ExtraColumn } from '../components/LeadsTable';
import {
  useDiscoveryActions,
  type DiscoveredContactWithLead,
} from '../hooks/useDiscoveredContacts';
import type { Lead, LeadStatus } from '../types/lead';
import LoadingState from '../ui/LoadingState';
import SectionHeader from '../ui/SectionHeader';

/** A compact status indicator — a single material icon + a tooltip-friendly label.
 *  Replaces the wider <Pill> approach that crushed the email/url text at laptop widths. */
interface StatusIcon {
  icon: string;
  /** Tailwind class for icon color, e.g. 'text-[#006630]'. */
  color: string;
  /** Human-readable status; shown in the cell tooltip. */
  label: string;
  /** When true the icon spins (for verifying / scraping). */
  spin?: boolean;
}

function emailStatusIcon(r: DiscoveredContactWithLead): StatusIcon {
  if (r.status === 'accepted')     return { icon: 'check_circle', color: 'text-[#006630]', label: 'Accepted' };
  if (r.status === 'spawned_lead') return { icon: 'arrow_outward', color: 'text-purple-600', label: 'Spawned to new lead' };
  switch (r.verification_status) {
    case 'valid':     return { icon: 'check_circle', color: 'text-[#006630]', label: 'Valid' };
    case 'invalid':   return { icon: 'cancel',       color: 'text-error',     label: 'Invalid' };
    case 'catch-all': return { icon: 'help',         color: 'text-amber-600', label: 'Catch-all domain' };
    case 'unknown':   return { icon: 'help',         color: 'text-slate-400', label: 'Unknown' };
  }
  return { icon: 'progress_activity', color: 'text-blue-500', label: 'Verifying…', spin: true };
}

function urlStatusIcon(r: DiscoveredContactWithLead): StatusIcon {
  if (r.status === 'accepted')     return { icon: 'check_circle', color: 'text-[#006630]', label: 'Accepted' };
  if (r.status === 'spawned_lead') return { icon: 'arrow_outward', color: 'text-purple-600', label: 'Spawned to new lead' };
  if (!r.scrape_result)            return { icon: 'progress_activity', color: 'text-blue-500', label: 'Scraping…', spin: true };
  const sr = r.scrape_result as Record<string, unknown>;
  if (sr.error)         return { icon: 'error',        color: 'text-error',     label: `Scrape failed: ${String(sr.error)}` };
  if (sr.website_email) return { icon: 'check_circle', color: 'text-[#006630]', label: `Email harvested (${String(sr.website_email)})` };
  return { icon: 'remove_circle', color: 'text-slate-400', label: 'Scrape ran but no email found' };
}

const COUNTRIES = [
  { code: '', name: 'All Countries' },
  { code: 'AU', name: 'Australia' }, { code: 'AT', name: 'Austria' },
  { code: 'BR', name: 'Brazil' }, { code: 'CA', name: 'Canada' },
  { code: 'DK', name: 'Denmark' }, { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' }, { code: 'DE', name: 'Germany' },
  { code: 'IT', name: 'Italy' }, { code: 'NL', name: 'Netherlands' },
  { code: 'NO', name: 'Norway' }, { code: 'ES', name: 'Spain' },
  { code: 'SE', name: 'Sweden' }, { code: 'AE', name: 'United Arab Emirates' },
  { code: 'GB', name: 'United Kingdom' }, { code: 'US', name: 'United States' },
];

// Pick the strongest discovery for a lead from its list of discovered_contacts.
//
// Strict email preference: an email is the actionable artefact (you can
// send to it, accept it, build a campaign from it). A URL is only ever an
// intermediate scrape target. Even an *accepted* URL is less useful than a
// pending email — accepting a URL is a no-op against `leads.discovered_email`.
// So:
//   - if the lead has ANY non-dismissed email candidate → pick the best email
//   - otherwise → pick the best URL (so the user can see the dead-end)
//
// Within a kind, ranking is: accepted > pending-valid > pending-verifying
// > pending-other > spawned, with the extractor's role/signal score as
// the tiebreaker.
function pickBestForLead(rows: DiscoveredContactWithLead[]): DiscoveredContactWithLead {
  const score = (r: DiscoveredContactWithLead): number => {
    let tier = 0;
    if (r.status === 'accepted')                                     tier = 1000;
    else if (r.status === 'pending_review' && r.verification_status === 'valid') tier = 800;
    else if (r.status === 'pending_review' && r.verification_status === 'catch-all') tier = 600;
    else if (r.status === 'pending_review' && !r.verification_status) tier = 500;  // verifying / scraping
    else if (r.status === 'pending_review')                            tier = 400;  // unknown / invalid
    else if (r.status === 'spawned_lead')                              tier = 200;
    return tier + r.score;
  };
  const emails = rows.filter((r) => r.kind === 'email');
  const pool = emails.length > 0 ? emails : rows;
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

// Pick the URL most worth surfacing as "source" — the URL the scraper was
// given (or the URL the harvested email originally came from). Returns null
// when the lead has no URL provenance at all.
function pickSourceUrl(
  rows: DiscoveredContactWithLead[],
  best: DiscoveredContactWithLead,
): DiscoveredContactWithLead | { value: string; status: 'harvested' } | null {
  // 1. Best candidate is an email harvested from a URL the worker scraped.
  //    The metadata records where it came from — the most informative source.
  if (best.kind === 'email' && best.auto_reply_metadata && typeof best.auto_reply_metadata === 'object') {
    const url = (best.auto_reply_metadata as Record<string, unknown>).harvested_from_url as string | undefined;
    if (url) return { value: url, status: 'harvested' };
  }
  // 2. Otherwise pick the highest-scoring non-dismissed URL candidate.
  const urls = rows.filter((r) => r.kind === 'url');
  if (urls.length === 0) return null;
  return [...urls].sort((a, b) => b.score - a.score)[0];
}

export default function Prospects() {
  const router = useRouter();
  const [countryFilter, setCountryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState('scraped_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const [rawDiscoveries, setRawDiscoveries] = useState<DiscoveredContactWithLead[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const { accept, dismiss, spawnLead, overrideStatus } = useDiscoveryActions();

  const toggleSort = (col: string) => {
    if (col === sortBy) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('desc'); }
    setPage(1);
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // status=all so pending + accepted + spawned all land here
      const res = await api.get('/discovered-contacts?status=all&limit=500');
      setRawDiscoveries(res.data?.data?.data ?? []);
    } catch {
      setRawDiscoveries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Periodic refresh — the worker is verifying / scraping in the background,
    // so the page picks up newly-verified candidates and harvested URL emails
    // without a manual reload.
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  // Group discoveries by lead, pick the best per lead.
  const leadRows = useMemo(() => {
    const byLead = new Map<string, DiscoveredContactWithLead[]>();
    for (const r of rawDiscoveries) {
      // Skip dismissed-only leads — those have already been triaged out.
      if (r.status === 'dismissed') continue;
      const list = byLead.get(r.lead_id) ?? [];
      list.push(r);
      byLead.set(r.lead_id, list);
    }

    const rows: Array<Lead & { _discovery: DiscoveredContactWithLead; _allDiscoveries: DiscoveredContactWithLead[] }> = [];
    for (const [leadId, list] of byLead) {
      const best = pickBestForLead(list);
      const lead = best.lead;
      if (!lead) continue;

      // Apply client-side filters (country / search) — server returns all
      // discoveries, we narrow on the page.
      if (countryFilter && lead.country !== countryFilter) continue;
      if (search) {
        const q = search.toLowerCase();
        const hay = `${lead.company_name ?? ''} ${best.value ?? ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      rows.push({
        ...(lead as Lead),
        // Override id with leadId so LeadsTable selection is per-lead, not
        // per-discovery (we only show one row per lead anyway).
        id: leadId,
        _discovery: best,
        _allDiscoveries: list,
      } as Lead & { _discovery: DiscoveredContactWithLead; _allDiscoveries: DiscoveredContactWithLead[] });
    }

    // Sort. Primary: scraped_at desc by default. The user can flip via column header.
    rows.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortBy] ?? '';
      const bv = (b as unknown as Record<string, unknown>)[sortBy] ?? '';
      if (av === bv) return 0;
      const cmp = String(av) > String(bv) ? 1 : -1;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [rawDiscoveries, countryFilter, search, sortBy, sortDir]);

  // Paginated slice — matches LeadsTable's pagination expectation
  const PAGE_SIZE = 25;
  const total = leadRows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pagedRows = leadRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleAccept = async (id: string) => {
    setBusyId(id);
    try { await accept(id); setStatusMsg('Discovery accepted — primary email rebuilt.'); await fetchData(); }
    finally { setBusyId(null); setTimeout(() => setStatusMsg(null), 4000); }
  };
  const handleDismiss = async (id: string) => {
    setBusyId(id);
    try { await dismiss(id); setStatusMsg('Discovery dismissed.'); await fetchData(); }
    finally { setBusyId(null); setTimeout(() => setStatusMsg(null), 4000); }
  };
  const handleSpawn = async (id: string) => {
    setBusyId(id);
    try {
      await spawnLead(id);
      setStatusMsg('New lead spawned from URL.');
      await fetchData();
    } catch (err: unknown) {
      // spawnLead can reject when the URL is a tracker / CDN / social
      // domain — surface the backend's reason so the user understands why.
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setStatusMsg(e?.response?.data?.error ?? e?.message ?? 'Spawn failed');
    }
    finally { setBusyId(null); setTimeout(() => setStatusMsg(null), 6000); }
  };
  const handleOverride = async (id: string, status: 'valid' | 'invalid' | 'catch-all' | 'unknown') => {
    setBusyId(id);
    try {
      await overrideStatus(id, status);
      setStatusMsg(`Verification overridden to '${status}'.`);
      await fetchData();
    } finally {
      setBusyId(null);
      setTimeout(() => setStatusMsg(null), 4000);
    }
  };

  // Discovery follow-up campaign launcher — sends only leads that have an
  // accepted discovered_email (otherwise the wizard would have nothing to
  // target). User said: once a lead becomes a prospect, the user creates a
  // new campaign manually — this button is the launcher into that wizard.
  const launchFollowUp = () => {
    if (selectedLeadIds.length === 0) return;
    const ready = leadRows.filter((r) => selectedLeadIds.includes(r.id) && r._discovery.status === 'accepted');
    if (ready.length === 0) {
      setStatusMsg('No accepted prospects in selection — Accept a discovery first.');
      setTimeout(() => setStatusMsg(null), 4000);
      return;
    }
    const csv = ready.map((r) => r.id).join(',');
    router.push(`/campaigns?wizard=1&discoveryMode=1&leadIds=${encodeURIComponent(csv)}`);
  };

  // ── LeadsTable extra columns / actions ────────────────────────────────
  //
  // Each cell renders ONE small status icon + the email/URL value. The icon
  // color encodes the status (green=accepted/valid/harvested, red=invalid/
  // failed, amber=catch-all, blue-spin=verifying/scraping, slate=unknown/none).
  // Full status text lives in the cell tooltip so rows stay compact at laptop
  // widths instead of getting crushed by a wide pill.
  const extraColumns: ExtraColumn[] = useMemo(() => [
    {
      key: 'discovered_email',
      label: 'Discovered Email',
      render: (lead) => {
        const r = (lead as Lead & { _discovery?: DiscoveredContactWithLead })._discovery;
        if (!r) return <span className="text-slate-300 text-xs">—</span>;
        const isAccepted = r.status === 'accepted';
        const isEmail = r.kind === 'email';
        const status = isEmail ? emailStatusIcon(r) : urlStatusIcon(r);

        const tooltip = [
          r.value,
          r.role ? `Role: ${r.role}` : null,
          status.label,
          `Status: ${r.status === 'pending_review' ? 'pending' : r.status}`,
        ].filter(Boolean).join(' • ');

        return (
          <div className="flex items-center gap-1.5 min-w-0" title={tooltip}>
            <span className={`material-symbols-outlined text-[14px] shrink-0 ${isEmail ? 'text-blue-500' : 'text-purple-500'}`}>
              {isEmail ? 'alternate_email' : 'link'}
            </span>
            <span className={`text-xs font-medium truncate flex-1 min-w-0 ${isAccepted ? 'text-on-surface' : 'text-secondary'}`}>
              {r.value}
            </span>
            <span
              className={`material-symbols-outlined text-[13px] shrink-0 ${status.color} ${status.spin ? 'animate-spin' : ''}`}
              aria-label={status.label}
            >
              {status.icon}
            </span>
          </div>
        );
      },
    },
    {
      key: 'source_url',
      label: 'Source',
      render: (lead) => {
        const row = lead as Lead & { _discovery?: DiscoveredContactWithLead; _allDiscoveries?: DiscoveredContactWithLead[] };
        if (!row._discovery || !row._allDiscoveries) return <span className="text-slate-300 text-xs">—</span>;
        const source = pickSourceUrl(row._allDiscoveries, row._discovery);
        if (!source) return <span className="text-slate-300 text-xs">—</span>;

        const isHarvestedRef = !('id' in source);
        const url = source.value;
        const status: StatusIcon = isHarvestedRef
          ? { icon: 'check_circle', color: 'text-[#006630]', label: 'Scrape produced the email shown' }
          : urlStatusIcon(source as DiscoveredContactWithLead);

        // Icon-only cell — text URL was eating ~180px on laptop widths for
        // little value (the URL itself rarely tells the user anything new).
        // The link is still clickable; hover or click-through shows the URL.
        return (
          <div className="flex items-center gap-1.5" title={`${url} — ${status.label}`}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              aria-label={`Open source URL: ${url}`}
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-purple-500 hover:bg-purple-50 transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">link</span>
            </a>
            <span
              className={`material-symbols-outlined text-[13px] shrink-0 ${status.color} ${status.spin ? 'animate-spin' : ''}`}
              aria-label={status.label}
            >
              {status.icon}
            </span>
          </div>
        );
      },
    },
  ], []);

  const extraRowActions = (lead: Lead) => {
    const r = (lead as Lead & { _discovery?: DiscoveredContactWithLead })._discovery;
    if (!r) return null;
    const busy = busyId === r.id;
    // Accepted state is already shown via the green check_circle in the
    // Discovered Email column — no need for a redundant text chip in the
    // Actions column that just gets truncated to "epted" on narrow tables.
    if (r.status === 'accepted') return null;
    return (
      <>
        <button
          onClick={() => handleAccept(r.id)}
          disabled={busy}
          title={r.kind === 'email' ? 'Accept — promote to lead.discovered_email' : 'Accept (URL)'}
          className="p-1 rounded-lg text-green-700 hover:bg-green-50 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[16px]">check</span>
        </button>
        {r.kind === 'email' && r.verification_status === 'invalid' && (
          // Hunter.io (last-resort verifier) returns false-invalid often
          // enough on lesser-indexed domains that the user needs an escape
          // hatch. Click → confirm → force valid; the lead's primary_email
          // rebuilds if the contact is already accepted.
          <button
            onClick={() => {
              if (confirm(`Override verification for ${r.value} to 'valid'?\n\nUse this when you've confirmed the address works (e.g. via a manual test send) and the verifier returned a wrong invalid.`)) {
                handleOverride(r.id, 'valid');
              }
            }}
            disabled={busy}
            title="Force valid — overrides the verifier's verdict"
            className="p-1 rounded-lg text-amber-700 hover:bg-amber-50 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px]">verified</span>
          </button>
        )}
        {r.kind === 'url' && (
          <button
            onClick={() => handleSpawn(r.id)}
            disabled={busy}
            title="Spawn new lead from this URL"
            className="p-1 rounded-lg text-purple-700 hover:bg-purple-50 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px]">add_link</span>
          </button>
        )}
        <button
          onClick={() => handleDismiss(r.id)}
          disabled={busy}
          title="Dismiss"
          className="p-1 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      </>
    );
  };

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-8 xl:px-10 xl:py-10 space-y-4 sm:space-y-6 pb-24 lg:pb-8">
      <SectionHeader
        title="Prospect"
        accent="Leads"
        subtitle="Leads with a discovered contact email — auto-detected from auto-replies or manually promoted from the Inbox. Cold sequences for these leads are paused automatically; create a new campaign once you accept the prospect's email."
      />

      {/* Status toast */}
      {statusMsg && (
        <div className="px-4 py-2 rounded-xl text-sm font-semibold bg-blue-50 text-blue-800 border border-blue-200 flex items-center gap-2">
          <span className="material-symbols-outlined text-[16px]">info</span>
          {statusMsg}
        </div>
      )}

      {/* Filters + bulk action toolbar */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 sm:flex-wrap">
        <div className="relative flex-1 sm:min-w-[200px]">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-secondary text-[18px]">search</span>
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search company or email..."
            className="w-full pl-10 pr-3 py-2.5 bg-surface-container rounded-lg text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
          />
        </div>
        <select
          value={countryFilter}
          onChange={(e) => { setCountryFilter(e.target.value); setPage(1); }}
          className="w-full sm:w-auto bg-surface-container rounded-lg px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
        >
          {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
        {selectedLeadIds.length > 0 && (
          <button
            onClick={launchFollowUp}
            className="hidden sm:flex items-center gap-2 px-4 py-2.5 rounded-lg primary-gradient text-on-primary text-sm font-bold ambient-shadow hover:scale-[1.02] transition-transform"
          >
            <span className="material-symbols-outlined text-[16px]">forward_to_inbox</span>
            New Campaign for {selectedLeadIds.length} prospect{selectedLeadIds.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {/* Mobile sticky CTA */}
      {selectedLeadIds.length > 0 && (
        <div className="sm:hidden fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 px-3 py-3 mobile-action-bar z-30 shadow-2xl flex items-center gap-2">
          <button
            onClick={() => setSelectedLeadIds([])}
            className="p-2 text-secondary"
            aria-label="Clear selection"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
          <button
            onClick={launchFollowUp}
            className="flex-1 px-4 py-2.5 primary-gradient text-on-primary rounded-lg font-bold text-sm flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-[16px]">forward_to_inbox</span>
            New Campaign ({selectedLeadIds.length})
          </button>
        </div>
      )}

      {/* Single-page list */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
        {loading && rawDiscoveries.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <LoadingState label="Loading prospects…" />
          </div>
        ) : (
          <LeadsTable
            leads={pagedRows as Lead[]}
            total={total}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            onStatusChange={async (id, status) => {
              await api.patch(`/leads/${id}`, { outreach_status: status as LeadStatus });
              await fetchData();
            }}
            onDelete={() => undefined /* deletion in this view isn't useful — Dismiss does the right thing */}
            selectedIds={selectedLeadIds}
            onSelect={setSelectedLeadIds}
            onLeadClick={(id) => router.push(`/leads/${id}`)}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={toggleSort}
            extraColumns={extraColumns}
            extraRowActions={extraRowActions}
            // The cold-target email columns plus a few rarely-useful matrix
            // columns are hidden so the new Discovered Email + Source URL +
            // action buttons fit without horizontal scrolling. The user can
            // open Lead Detail to see everything at full fidelity.
            hideColumns={['trustpilot_email', 'website_email', 'affiliate_email', 'tags', 'claimed', 'screenshot']}
          />
        )}
      </div>
    </div>
  );
}

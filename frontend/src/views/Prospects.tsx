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

const COUNTRIES = [
  { code: '', name: 'All Countries' },
  { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' }, { code: 'CA', name: 'Canada' },
  { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' }, { code: 'DK', name: 'Denmark' },
  { code: 'SE', name: 'Sweden' }, { code: 'NO', name: 'Norway' },
  { code: 'FI', name: 'Finland' }, { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' }, { code: 'BR', name: 'Brazil' },
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

  const { accept, dismiss, spawnLead } = useDiscoveryActions();

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
    try { await spawnLead(id); setStatusMsg('New lead spawned from URL.'); await fetchData(); }
    finally { setBusyId(null); setTimeout(() => setStatusMsg(null), 4000); }
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
  const extraColumns: ExtraColumn[] = useMemo(() => [
    {
      key: 'discovered_email',
      label: 'Discovered Email',
      render: (lead) => {
        const r = (lead as Lead & { _discovery?: DiscoveredContactWithLead })._discovery;
        if (!r) return <span className="text-slate-300 text-xs">—</span>;
        const isAccepted = r.status === 'accepted';
        return (
          <div className="flex flex-col gap-1 max-w-[280px]">
            <span className="inline-flex items-center gap-1 text-xs">
              <span className={`material-symbols-outlined text-[14px] ${r.kind === 'email' ? 'text-blue-500' : 'text-purple-500'}`}>
                {r.kind === 'email' ? 'alternate_email' : 'link'}
              </span>
              <span className={`font-medium truncate ${isAccepted ? 'text-on-surface' : 'text-secondary'}`} title={r.value}>
                {r.value}
              </span>
            </span>
            <div className="flex items-center gap-1 flex-wrap">
              {r.role && (
                <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">{r.role}</span>
              )}
              {r.kind === 'url'
                ? (() => {
                    if (!r.scrape_result) {
                      return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">scraping…</span>;
                    }
                    const sr = r.scrape_result as Record<string, unknown>;
                    if (sr.error) {
                      return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700" title={String(sr.error)}>scrape failed</span>;
                    }
                    if (sr.website_email) {
                      return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-50 text-green-700" title={`Harvested ${sr.website_email}`}>email harvested</span>;
                    }
                    return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">no email found</span>;
                  })()
                : r.verification_status ? (
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                        r.verification_status === 'valid' ? 'bg-green-50 text-green-700' :
                        r.verification_status === 'invalid' ? 'bg-red-50 text-red-700' :
                        r.verification_status === 'catch-all' ? 'bg-amber-50 text-amber-700' :
                        'bg-slate-50 text-slate-500'
                      }`}
                    >
                      {r.verification_status}
                    </span>
                  ) : (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">verifying…</span>
                  )
              }
              <span
                className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                  r.status === 'accepted' ? 'bg-green-100 text-green-800' :
                  r.status === 'pending_review' ? 'bg-blue-50 text-blue-700' :
                  r.status === 'spawned_lead' ? 'bg-purple-50 text-purple-700' :
                  'bg-slate-50 text-slate-500'
                }`}
              >
                {r.status === 'pending_review' ? 'pending' : r.status === 'spawned_lead' ? 'spawned' : r.status}
              </span>
            </div>
          </div>
        );
      },
    },
    {
      key: 'source_url',
      label: 'Source URL',
      render: (lead) => {
        const row = lead as Lead & { _discovery?: DiscoveredContactWithLead; _allDiscoveries?: DiscoveredContactWithLead[] };
        if (!row._discovery || !row._allDiscoveries) return <span className="text-slate-300 text-xs">—</span>;
        const source = pickSourceUrl(row._allDiscoveries, row._discovery);
        if (!source) return <span className="text-slate-300 text-xs">—</span>;

        // 'harvested_from_url' synthetic entry vs a real DiscoveredContact row
        const isHarvestedRef = !('id' in source);
        const url = source.value;
        const display = url.replace(/^https?:\/\//, '').replace(/\/$/, '');

        let badge: React.ReactNode = null;
        if (isHarvestedRef) {
          badge = <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-50 text-green-700" title="Scrape produced the email shown on the left">harvested ✓</span>;
        } else {
          const r = source as DiscoveredContactWithLead;
          if (!r.scrape_result) {
            badge = <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">scraping…</span>;
          } else {
            const sr = r.scrape_result as Record<string, unknown>;
            if (sr.error)              badge = <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700" title={String(sr.error)}>scrape failed</span>;
            else if (sr.website_email) badge = <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-50 text-green-700" title={`Harvested ${sr.website_email}`}>email harvested</span>;
            else                       badge = <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700" title="Scrape ran but found no email — open the URL manually to investigate">no email found</span>;
          }
        }

        return (
          <div className="flex flex-col gap-1 max-w-[260px]">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-xs text-[#b0004a] hover:underline"
              title={url}
            >
              <span className="material-symbols-outlined text-[12px] text-purple-500">link</span>
              <span className="truncate">{display}</span>
              <span className="material-symbols-outlined text-[10px] shrink-0">open_in_new</span>
            </a>
            {badge}
          </div>
        );
      },
    },
  ], []);

  const extraRowActions = (lead: Lead) => {
    const r = (lead as Lead & { _discovery?: DiscoveredContactWithLead })._discovery;
    if (!r) return null;
    const busy = busyId === r.id;
    if (r.status === 'accepted') {
      return (
        <span className="text-[10px] font-bold text-green-700 px-1.5">accepted</span>
      );
    }
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
    <div className="px-6 py-8 xl:px-10 xl:py-10 space-y-6">
      <div>
        <h2
          className="text-4xl font-extrabold tracking-tight text-on-surface"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Prospect <span className="text-[#b0004a]">Leads</span>
        </h2>
        <p className="text-secondary font-medium mt-1">
          Leads with a discovered contact email — auto-detected from auto-replies or
          manually promoted from the Inbox. Cold sequences for these leads are paused
          automatically; create a new campaign once you accept the prospect's email.
        </p>
      </div>

      {/* Status toast */}
      {statusMsg && (
        <div className="px-4 py-2 rounded-xl text-sm font-semibold bg-blue-50 text-blue-800 border border-blue-200 flex items-center gap-2">
          <span className="material-symbols-outlined text-[16px]">info</span>
          {statusMsg}
        </div>
      )}

      {/* Filters + bulk action toolbar */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-4 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-secondary text-[18px]">search</span>
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search company or discovered email..."
            className="w-full pl-10 pr-3 py-2.5 bg-surface-container rounded-lg text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
          />
        </div>
        <select
          value={countryFilter}
          onChange={(e) => { setCountryFilter(e.target.value); setPage(1); }}
          className="bg-surface-container rounded-lg px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
        >
          {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
        {selectedLeadIds.length > 0 && (
          <button
            onClick={launchFollowUp}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg primary-gradient text-on-primary text-sm font-bold ambient-shadow hover:scale-[1.02] transition-transform"
          >
            <span className="material-symbols-outlined text-[16px]">forward_to_inbox</span>
            New Campaign for {selectedLeadIds.length} prospect{selectedLeadIds.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {/* Single-page list */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
        {loading && rawDiscoveries.length === 0 ? (
          <div className="flex items-center justify-center h-48 gap-2 text-secondary">
            <span className="material-symbols-outlined text-[#b0004a] text-[20px] animate-spin">progress_activity</span>
            Loading prospects...
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
            // Original cold-target emails are noise on this view — the
            // discovered email column on the right is the only one that
            // matters for prospect outreach.
            hideColumns={['trustpilot_email', 'website_email', 'affiliate_email']}
          />
        )}
      </div>
    </div>
  );
}

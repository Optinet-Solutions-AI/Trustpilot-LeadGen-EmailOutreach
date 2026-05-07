'use client';

/**
 * Prospects view — three-tab review queue for leads showing real customer
 * signal, mounted at /prospects.
 *
 *   Discoveries   — pending discovered_contacts rows (Accept / Dismiss / Spawn)
 *   Human Replies — leads with at least one campaign_leads.status='replied'
 *   Accepted      — leads with discovered_email != null, multi-select for the
 *                   discovery follow-up campaign launcher.
 *
 * All three tabs render through the existing LeadsTable so country filter,
 * draggable column reordering, and sort behave identically to the Lead
 * Matrix. The Discoveries tab passes extraColumns + extraRowActions to slot
 * in discovery-specific fields without forking the table component.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import LeadsTable, { type ExtraColumn } from '../components/LeadsTable';
import { useLeads } from '../hooks/useLeads';
import {
  usePendingDiscoveries,
  useDiscoveryActions,
  type DiscoveredContactWithLead,
} from '../hooks/useDiscoveredContacts';
import type { Lead, LeadStatus } from '../types/lead';
import api from '../api/client';

type Tab = 'discoveries' | 'human_replies' | 'accepted';

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

export default function Prospects() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('discoveries');
  const [countryFilter, setCountryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState('scraped_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const toggleSort = (col: string) => {
    if (col === sortBy) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('desc'); }
    setPage(1);
  };

  // Reset selection on tab switch — selected IDs are tab-scoped (a discovery
  // ID and a lead ID are not interchangeable, but lead IDs across the two
  // lead-list tabs would still be different selections in practice).
  useEffect(() => {
    setSelectedIds([]);
    setPage(1);
  }, [tab]);

  return (
    <div className="px-6 py-8 xl:px-10 xl:py-10 space-y-8">
      <div>
        <h2
          className="text-4xl font-extrabold tracking-tight text-on-surface"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Prospect <span className="text-[#b0004a]">Leads</span>
        </h2>
        <p className="text-secondary font-medium mt-1">
          Auto-replies, human replies, and accepted discovered contacts — the
          customer-signal queue.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-100">
        {([
          { key: 'discoveries',   label: 'Discoveries',  icon: 'inbox' },
          { key: 'human_replies', label: 'Human Replies', icon: 'mark_email_unread' },
          { key: 'accepted',      label: 'Accepted',     icon: 'check_circle' },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-bold border-b-2 transition-colors ${
              tab === t.key
                ? 'border-[#b0004a] text-[#b0004a]'
                : 'border-transparent text-secondary hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters — shared row matching the Leads page UX */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-5">
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-secondary text-[18px]">search</span>
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search companies..."
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
        </div>
      </div>

      {/* Tab content */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
        {tab === 'discoveries' && (
          <DiscoveriesTab
            countryFilter={countryFilter}
            search={search}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={toggleSort}
            page={page}
            onPageChange={setPage}
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
            onLeadClick={(id) => router.push(`/leads/${id}`)}
          />
        )}
        {tab === 'human_replies' && (
          <RepliesTab
            countryFilter={countryFilter}
            search={search}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={toggleSort}
            page={page}
            onPageChange={setPage}
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
            onLeadClick={(id) => router.push(`/leads/${id}`)}
          />
        )}
        {tab === 'accepted' && (
          <AcceptedTab
            countryFilter={countryFilter}
            search={search}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={toggleSort}
            page={page}
            onPageChange={setPage}
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
            onLeadClick={(id) => router.push(`/leads/${id}`)}
            onLaunchFollowUp={(ids) => {
              if (ids.length === 0) return;
              const csv = ids.join(',');
              router.push(`/campaigns?wizard=1&discoveryMode=1&leadIds=${encodeURIComponent(csv)}`);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Discoveries tab ─────────────────────────────────────────────────────

function DiscoveriesTab(props: {
  countryFilter: string;
  search: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSortChange: (col: string) => void;
  page: number;
  onPageChange: (p: number) => void;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onLeadClick: (id: string) => void;
}) {
  const { data, total, loading, refresh } = usePendingDiscoveries({ status: 'pending_review', limit: 100 });
  const { accept, dismiss, spawnLead } = useDiscoveryActions();
  const [busyId, setBusyId] = useState<string | null>(null);

  // Filter by country + search client-side. The list is already capped at 100;
  // server-side filtering would add complexity for a second-pass refinement.
  const filtered = useMemo(() => {
    let rows = data;
    if (props.countryFilter) {
      rows = rows.filter((r) => r.lead?.country === props.countryFilter);
    }
    if (props.search) {
      const q = props.search.toLowerCase();
      rows = rows.filter((r) =>
        (r.lead?.company_name ?? '').toLowerCase().includes(q) ||
        r.value.toLowerCase().includes(q),
      );
    }
    return rows;
  }, [data, props.countryFilter, props.search]);

  // Synthesise a Lead-shaped row per discovery so LeadsTable can render it.
  // We carry the discovery payload on a non-standard `_discovery` field; the
  // extraColumns renderer reads it back via type assertion.
  const leadRows: Lead[] = useMemo(() =>
    filtered.map((r) => {
      const lead = r.lead;
      const synthesized: Lead = lead
        ? { ...lead }
        : {
            id: r.lead_id,
            company_name: '(unknown lead)',
            trustpilot_url: '',
            website_url: null,
            trustpilot_email: null,
            website_email: null,
            affiliate_email: null,
            primary_email: null,
            phone: null,
            country: null,
            category: null,
            star_rating: null,
            email_verified: false,
            verification_status: 'unknown',
            trustpilot_email_status: null,
            website_email_status: null,
            affiliate_email_status: null,
            verify_syntax_ok: null,
            verify_mx_ok: null,
            verify_smtp_result: null,
            verify_zerobounce_result: null,
            verified_at: null,
            outreach_status: 'new',
            link_status: 'UNKNOWN',
            last_validated_at: null,
            link_validation_error: null,
            screenshot_path: null,
            profile_claimed: null,
            redirects_to: null,
            tags: [],
            lead_source: 'discovery',
            scraped_at: null,
            contacted_at: null,
            created_at: r.created_at,
            updated_at: r.created_at,
          };
      return Object.assign({}, synthesized, {
        // We need the DISCOVERY id to be the row's ID for selection; otherwise
        // selecting two discoveries on the same lead would dedup. Use a
        // composite that LeadsTable still accepts as a string id.
        id: `${r.id}__${r.lead_id}`,
        _discovery: r,
      } as unknown as Partial<Lead>);
    }),
  [filtered]);

  const extraColumns: ExtraColumn[] = useMemo(() => [
    {
      key: 'discovered_value',
      label: 'Discovered',
      render: (lead) => {
        const r = (lead as Lead & { _discovery?: DiscoveredContactWithLead })._discovery;
        if (!r) return <span className="text-slate-300 text-xs">—</span>;
        return (
          <div className="flex flex-col gap-1 max-w-[260px]">
            <span className="inline-flex items-center gap-1 text-xs">
              <span className={`material-symbols-outlined text-[14px] ${r.kind === 'email' ? 'text-blue-500' : 'text-purple-500'}`}>
                {r.kind === 'email' ? 'alternate_email' : 'link'}
              </span>
              <span className="font-medium truncate">{r.value}</span>
            </span>
            {r.kind === 'url' && r.scrape_result ? (
              <ScrapeResultPreview scrape={r.scrape_result} />
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'discovered_role',
      label: 'Role',
      render: (lead) => {
        const r = (lead as Lead & { _discovery?: DiscoveredContactWithLead })._discovery;
        if (!r) return null;
        return (
          <span className="text-xs text-secondary capitalize whitespace-nowrap">
            {r.role ?? '—'} <span className="text-slate-300">({r.score})</span>
          </span>
        );
      },
    },
    {
      key: 'verification_status',
      label: 'Verification',
      render: (lead) => {
        const r = (lead as Lead & { _discovery?: DiscoveredContactWithLead })._discovery;
        if (!r) return null;
        if (!r.verification_status) {
          return <span className="text-[10px] font-bold bg-slate-50 text-slate-500 px-1.5 py-0.5 rounded-full">verifying…</span>;
        }
        const palette: Record<string, string> = {
          'valid':     'bg-green-50 text-green-700',
          'invalid':   'bg-red-50 text-red-700',
          'catch-all': 'bg-amber-50 text-amber-700',
          'unknown':   'bg-slate-50 text-slate-500',
        };
        return (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${palette[r.verification_status] ?? ''}`}>
            {r.verification_status}
          </span>
        );
      },
    },
  ], []);

  const handleAccept = async (discoveryId: string) => {
    setBusyId(discoveryId);
    try { await accept(discoveryId); await refresh(); }
    finally { setBusyId(null); }
  };
  const handleDismiss = async (discoveryId: string) => {
    setBusyId(discoveryId);
    try { await dismiss(discoveryId); await refresh(); }
    finally { setBusyId(null); }
  };
  const handleSpawn = async (discoveryId: string) => {
    setBusyId(discoveryId);
    try { await spawnLead(discoveryId); await refresh(); }
    finally { setBusyId(null); }
  };

  const extraRowActions = (lead: Lead) => {
    const r = (lead as Lead & { _discovery?: DiscoveredContactWithLead })._discovery;
    if (!r) return null;
    const busy = busyId === r.id;
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

  if (loading && data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 gap-2 text-secondary">
        <span className="material-symbols-outlined text-[#b0004a] text-[20px] animate-spin">progress_activity</span>
        Loading discoveries...
      </div>
    );
  }

  return (
    <LeadsTable
      leads={leadRows}
      total={total}
      page={props.page}
      totalPages={Math.max(1, Math.ceil(filtered.length / 25))}
      onPageChange={props.onPageChange}
      onStatusChange={() => undefined /* status is irrelevant in the discovery tab */}
      onDelete={() => undefined /* delete-from-discovery doesn't make sense; use Dismiss */}
      selectedIds={props.selectedIds}
      onSelect={props.onSelect}
      onLeadClick={(rowId) => {
        // rowId is "discoveryId__leadId" — route to the lead.
        const leadId = rowId.split('__')[1];
        if (leadId) props.onLeadClick(leadId);
      }}
      sortBy={props.sortBy}
      sortDir={props.sortDir}
      onSortChange={props.onSortChange}
      extraColumns={extraColumns}
      extraRowActions={extraRowActions}
    />
  );
}

function ScrapeResultPreview({ scrape }: { scrape: Record<string, unknown> }) {
  const email = scrape.website_email as string | undefined;
  const company = scrape.company_name as string | undefined;
  if (!email && !company) {
    return <span className="text-[10px] text-slate-400">scraping…</span>;
  }
  return (
    <span className="text-[10px] text-secondary">
      {company ? <strong className="text-on-surface">{company}</strong> : null}
      {email ? <> · {email}</> : null}
    </span>
  );
}

// ── Human Replies tab ───────────────────────────────────────────────────

function RepliesTab(props: {
  countryFilter: string;
  search: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSortChange: (col: string) => void;
  page: number;
  onPageChange: (p: number) => void;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onLeadClick: (id: string) => void;
}) {
  // Human replies are leads where outreach_status='replied'. We piggyback on
  // the existing /api/leads endpoint so country filter + sort are server-side
  // for free.
  const { leads, total, totalPages, loading, fetchLeads, updateLead, deleteLead } = useLeads();

  const reload = useCallback(() => {
    const filters: Record<string, string | number> = {
      page: props.page, limit: 25, status: 'replied',
      sortBy: props.sortBy, sortDir: props.sortDir,
    };
    if (props.countryFilter) filters.country = props.countryFilter;
    if (props.search) filters.search = props.search;
    fetchLeads(filters as Parameters<typeof fetchLeads>[0]);
  }, [props.page, props.countryFilter, props.search, props.sortBy, props.sortDir, fetchLeads]);
  useEffect(() => { reload(); }, [reload]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 gap-2 text-secondary">
        <span className="material-symbols-outlined text-[#b0004a] text-[20px] animate-spin">progress_activity</span>
        Loading replies...
      </div>
    );
  }

  return (
    <LeadsTable
      leads={leads}
      total={total}
      page={props.page}
      totalPages={totalPages}
      onPageChange={props.onPageChange}
      onStatusChange={(id, status) => updateLead(id, { outreach_status: status as LeadStatus })}
      onDelete={deleteLead}
      selectedIds={props.selectedIds}
      onSelect={props.onSelect}
      onLeadClick={props.onLeadClick}
      sortBy={props.sortBy}
      sortDir={props.sortDir}
      onSortChange={props.onSortChange}
    />
  );
}

// ── Accepted tab ────────────────────────────────────────────────────────

function AcceptedTab(props: {
  countryFilter: string;
  search: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSortChange: (col: string) => void;
  page: number;
  onPageChange: (p: number) => void;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onLeadClick: (id: string) => void;
  onLaunchFollowUp: (ids: string[]) => void;
}) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);

  // Custom fetch: there's no existing leads filter for "discovered_email IS
  // NOT NULL" so we hit the leads endpoint and post-filter. For the volume
  // we expect (dozens, not thousands), client-side filter is fine.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({
      page: String(props.page), limit: '100',
      sortBy: props.sortBy, sortDir: props.sortDir,
    });
    if (props.countryFilter) params.set('country', props.countryFilter);
    if (props.search) params.set('search', props.search);

    api.get(`/leads?${params}`)
      .then((res) => {
        if (cancelled) return;
        const all: Lead[] = res.data.data ?? [];
        const filtered = all.filter((l) => (l as Lead & { discovered_email?: string | null }).discovered_email);
        setLeads(filtered);
        setTotal(filtered.length);
        setTotalPages(Math.max(1, Math.ceil(filtered.length / 25)));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.page, props.countryFilter, props.search, props.sortBy, props.sortDir]);

  const handleStatusChange = async (id: string, status: LeadStatus) => {
    await api.patch(`/leads/${id}`, { outreach_status: status });
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, outreach_status: status } : l)));
  };
  const handleDelete = async (id: string) => {
    await api.delete(`/leads/${id}`);
    setLeads((prev) => prev.filter((l) => l.id !== id));
  };

  const launchFollowUp = () => {
    if (props.selectedIds.length === 0) return;
    props.onLaunchFollowUp(props.selectedIds);
  };

  return (
    <div>
      {props.selectedIds.length > 0 && (
        <div className="flex items-center justify-between p-4 border-b border-slate-100 bg-amber-50/50">
          <span className="text-sm font-bold text-on-surface">
            {props.selectedIds.length} accepted prospect{props.selectedIds.length === 1 ? '' : 's'} selected
          </span>
          <button
            onClick={launchFollowUp}
            className="px-4 py-2 rounded-lg primary-gradient text-on-primary text-sm font-bold flex items-center gap-2 hover:scale-[1.02] transition-transform"
          >
            <span className="material-symbols-outlined text-[16px]">forward_to_inbox</span>
            Send Discovery Follow-Up Campaign
          </button>
        </div>
      )}
      {loading ? (
        <div className="flex items-center justify-center h-48 gap-2 text-secondary">
          <span className="material-symbols-outlined text-[#b0004a] text-[20px] animate-spin">progress_activity</span>
          Loading...
        </div>
      ) : (
        <LeadsTable
          leads={leads}
          total={total}
          page={props.page}
          totalPages={totalPages}
          onPageChange={props.onPageChange}
          onStatusChange={handleStatusChange}
          onDelete={handleDelete}
          selectedIds={props.selectedIds}
          onSelect={props.onSelect}
          onLeadClick={props.onLeadClick}
          sortBy={props.sortBy}
          sortDir={props.sortDir}
          onSortChange={props.onSortChange}
        />
      )}
    </div>
  );
}

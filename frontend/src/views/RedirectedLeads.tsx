'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLeads } from '../hooks/useLeads';
import api from '../api/client';
import type { Lead } from '../types/lead';

/**
 * Redirected Leads — leads whose website_url 30x'd to a different registrable
 * domain during enrichment. We deliberately hide them from the main Lead Matrix
 * because reaching out with the standard "I noticed your bad reviews on X" copy
 * doesn't make sense when the operator has already moved to a different brand.
 *
 * From this page, the user creates campaigns with redirect-aware copy
 * (e.g. "noticed Y now points to Z — are you still operating Y?") so the
 * lead isn't lost but also isn't mis-targeted.
 *
 * Row click opens a lightweight inline drawer showing the lead's details —
 * sourced entirely from data already loaded for the row, so it's effectively
 * instant. We deliberately don't navigate to /leads/:id from here: that view
 * eagerly loads notes, follow-ups, discovered contacts, claimed-check job
 * status, and an activity timeline, which is overkill for the "I just want to
 * glance at this lead" interaction this page is built around. The checkbox
 * cell is isolated with stopPropagation so picking a lead for the bulk
 * campaign action doesn't also pop the drawer.
 */
export default function RedirectedLeads() {
  const router = useRouter();
  const { leads, total, totalPages, loading, fetchLeads } = useLeads();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeLead, setActiveLead] = useState<Lead | null>(null);

  const loadLeads = useCallback(() => {
    const filters: Record<string, string | number> = {
      page,
      limit: 25,
      sortBy: 'scraped_at',
      sortDir: 'desc',
    };
    if (search) filters.search = search;
    (filters as Record<string, unknown>).redirected = 'only';
    fetchLeads(filters as Parameters<typeof fetchLeads>[0]);
  }, [page, search, fetchLeads]);

  useEffect(() => { loadLeads(); }, [loadLeads]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const toggleAll = () => {
    setSelectedIds((prev) => prev.length === leads.length ? [] : leads.map((l) => l.id));
  };

  const handleClearRedirect = async (lead: { id: string; redirects_to?: string | null; website_url?: string | null }) => {
    // Clearing redirects_to alone caused an infinite loop: the lead came back
    // to the main pipeline still pointing at the original Trustpilot-listed
    // domain, the next enrich hit the same redirect, and re-flagged it. Now
    // we also rewrite website_url to the redirect target so the next enrich
    // visits the new domain directly — no redirect, full tier ladder runs
    // (homepage → sitemap → contact → ScrapingBee → WHOIS → Wayback → crt.sh
    // → lateral prospecting). The user has effectively endorsed the redirect
    // target as canonical for this lead.
    const target = lead.redirects_to;
    if (!target) return;
    const newWebsiteUrl = /^https?:\/\//i.test(target) ? target : `https://${target}`;
    if (!confirm(
      `Treat ${target} as this lead's canonical website?\n\n` +
      `• website_url will be replaced with ${newWebsiteUrl}\n` +
      `• Redirect flag will be cleared\n` +
      `• Next "Enrich All" will run the full email-discovery ladder against the new domain`
    )) return;
    setBusy(true);
    try {
      await api.patch(`/leads/${lead.id}`, {
        redirects_to: null,
        website_url: newWebsiteUrl,
      });
      setActiveLead(null);
      loadLeads();
    } finally {
      setBusy(false);
    }
  };

  const handleStartCampaign = () => {
    if (selectedIds.length === 0) {
      alert('Select at least one redirected lead first.');
      return;
    }
    // Hand off to the campaign wizard with these leads pre-selected. The user
    // is expected to use a different subject/body template tailored for
    // redirect-flagged outreach (e.g. "I noticed X now points to Y — are you
    // still the operator?"). The wizard reads the leadIds query param.
    const ids = selectedIds.join(',');
    router.push(`/campaigns?wizard=1&leadIds=${encodeURIComponent(ids)}&redirectMode=1`);
  };

  // Page-number window: show up to 7 numbered buttons clustered around the
  // current page (mirrors the LeadsTable convention so the two pages feel
  // consistent). On totals <=7 we just render every page; beyond that we
  // slide a 7-wide window. The math is bounded so the window never extends
  // past the first or last page.
  const pageWindow = ((): number[] => {
    const maxButtons = 7;
    if (totalPages <= maxButtons) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const half = Math.floor(maxButtons / 2);
    let start = Math.max(1, page - half);
    const end = Math.min(totalPages, start + maxButtons - 1);
    start = Math.max(1, end - maxButtons + 1);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  })();

  return (
    <div className="p-3 sm:p-6 max-w-screen-2xl mx-auto pb-24 lg:pb-6">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold">
          Redirected <span className="text-rose-600">Leads</span>
        </h1>
        <p className="text-slate-600 mt-1 text-sm sm:text-base">
          {total} {total === 1 ? 'lead' : 'leads'} whose websites redirect to a different brand. Outreach
          to these requires different messaging — don't run the standard cold-email template.
        </p>
      </div>

      <div className="mb-4 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }}
          placeholder="Search company or domain…"
          className="flex-1 sm:min-w-[280px] px-4 py-2 border border-slate-200 rounded-lg bg-white"
        />
        <button
          onClick={handleStartCampaign}
          disabled={selectedIds.length === 0 || busy}
          className="hidden sm:inline-block px-4 py-2 bg-rose-600 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create redirect-aware campaign ({selectedIds.length})
        </button>
      </div>

      {loading ? (
        <div className="p-12 text-center text-slate-500">Loading…</div>
      ) : leads.length === 0 ? (
        <div className="p-12 text-center bg-white rounded-lg border border-slate-200">
          <p className="text-slate-500">
            No redirected leads yet. They'll appear here automatically when the enricher detects
            a website that redirects to a different brand.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-100 overflow-clip ambient-shadow">
        {/* Mobile cards */}
        <div className="lg:hidden divide-y divide-slate-100">
          {leads.map((lead) => {
            const listedDomain = (lead.website_url || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
            const isChecked = selectedIds.includes(lead.id);
            return (
              <div
                key={lead.id}
                onClick={() => setActiveLead(lead)}
                className={`p-3 flex gap-3 active:bg-slate-50 cursor-pointer ${isChecked ? 'bg-rose-50/30' : ''}`}
              >
                <label
                  className="flex items-start pt-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleSelect(lead.id)}
                    className="w-5 h-5 accent-rose-600"
                  />
                </label>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="font-bold text-sm truncate flex-1">{lead.company_name}</p>
                    {lead.star_rating != null && (
                      <span className="flex-shrink-0 text-xs text-amber-600 font-bold">★ {lead.star_rating.toFixed(1)}</span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 mb-1.5">{listedDomain || '—'} {lead.country ? `· ${lead.country}` : ''}</p>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 rounded text-[11px] max-w-full">
                    <span className="material-symbols-outlined text-sm flex-shrink-0">arrow_forward</span>
                    <span className="truncate">{lead.redirects_to}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop table */}
        <div className="hidden lg:block">
          <table className="w-full text-sm">
            <thead className="bg-surface-container border-b border-slate-100">
              <tr>
                <th className="px-4 py-3 text-left w-10">
                  <input
                    type="checkbox"
                    checked={selectedIds.length === leads.length && leads.length > 0}
                    onChange={toggleAll}
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-secondary">Company</th>
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-secondary">Listed Domain</th>
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-secondary">Redirects To</th>
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-secondary">Country</th>
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-secondary">Rating</th>
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-secondary">Detected</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
                const listedDomain = (lead.website_url || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
                const isChecked = selectedIds.includes(lead.id);
                return (
                  <tr
                    key={lead.id}
                    onClick={() => setActiveLead(lead)}
                    className={`border-b border-slate-100 cursor-pointer transition-colors ${isChecked ? 'bg-rose-50/30 hover:bg-rose-50/50' : 'hover:bg-slate-50'}`}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(lead.id)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-bold text-slate-900">{lead.company_name}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{listedDomain || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 px-2 py-1 bg-amber-50 text-amber-700 rounded text-xs">
                        <span className="material-symbols-outlined text-sm">arrow_forward</span>
                        {lead.redirects_to}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{lead.country || '—'}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {lead.star_rating ? `${lead.star_rating} ★` : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {lead.scraped_at ? new Date(lead.scraped_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination — mirrors LeadsTable so the two pages share a control
            language. Mobile collapses to prev/next plus a "page X of Y" hint
            (numbered buttons get cramped under ~640px); desktop shows a
            sliding 7-button window centred on the current page. */}
        {totalPages > 1 && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-3 sm:px-4 py-3 border-t border-slate-100 bg-surface-container">
            <span className="text-xs font-semibold text-secondary">
              {total} leads total <span className="sm:hidden">· page {page} of {totalPages}</span>
            </span>
            {/* Mobile: prev/next + current/total */}
            <div className="flex sm:hidden items-center justify-between gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg bg-white border border-slate-200 text-secondary disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-[16px]">chevron_left</span>
                Prev
              </button>
              <span className="text-xs font-bold text-on-surface">{page} / {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg bg-white border border-slate-200 text-secondary disabled:opacity-40"
              >
                Next
                <span className="material-symbols-outlined text-[16px]">chevron_right</span>
              </button>
            </div>
            {/* Desktop: numbered pages with chevron edges */}
            <div className="hidden sm:flex gap-1 items-center">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="flex items-center px-2 py-1 text-xs rounded-lg bg-white border border-slate-200 text-secondary disabled:opacity-40"
                aria-label="Previous page"
              >
                <span className="material-symbols-outlined text-[16px]">chevron_left</span>
              </button>
              {pageWindow[0] > 1 && (
                <>
                  <button
                    onClick={() => setPage(1)}
                    className="px-2.5 py-1 text-xs rounded-lg font-bold bg-white border border-slate-200 text-secondary hover:bg-surface-container"
                  >
                    1
                  </button>
                  {pageWindow[0] > 2 && <span className="text-xs text-secondary px-1">…</span>}
                </>
              )}
              {pageWindow.map((p) => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`px-2.5 py-1 text-xs rounded-lg font-bold transition-colors ${
                    p === page
                      ? 'bg-rose-600 text-white'
                      : 'bg-white border border-slate-200 text-secondary hover:bg-surface-container'
                  }`}
                >
                  {p}
                </button>
              ))}
              {pageWindow[pageWindow.length - 1] < totalPages && (
                <>
                  {pageWindow[pageWindow.length - 1] < totalPages - 1 && <span className="text-xs text-secondary px-1">…</span>}
                  <button
                    onClick={() => setPage(totalPages)}
                    className="px-2.5 py-1 text-xs rounded-lg font-bold bg-white border border-slate-200 text-secondary hover:bg-surface-container"
                  >
                    {totalPages}
                  </button>
                </>
              )}
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="flex items-center px-2 py-1 text-xs rounded-lg bg-white border border-slate-200 text-secondary disabled:opacity-40"
                aria-label="Next page"
              >
                <span className="material-symbols-outlined text-[16px]">chevron_right</span>
              </button>
            </div>
          </div>
        )}
        </div>
      )}

      {/* Mobile sticky Create button */}
      {selectedIds.length > 0 && (
        <div className="lg:hidden fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 px-3 py-3 mobile-action-bar z-30 shadow-2xl flex items-center gap-2">
          <button
            onClick={() => setSelectedIds([])}
            className="p-2 text-secondary"
            aria-label="Clear selection"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
          <button
            onClick={handleStartCampaign}
            disabled={busy}
            className="flex-1 px-4 py-2.5 bg-rose-600 text-white rounded-lg font-bold text-sm disabled:opacity-50"
          >
            Create campaign ({selectedIds.length})
          </button>
        </div>
      )}

      {/* Inline details drawer — all data is sourced from the already-loaded
          lead object so opening it is instant. We never fetch /leads/:id
          here: that endpoint pulls notes, follow-ups, discoveries, claimed
          check jobs and timeline data which would defeat the "fast glance"
          intent of this page. If the user needs the full picture, they can
          open the Trustpilot link or use the Lead Matrix instead. */}
      <LeadDetailsDrawer
        lead={activeLead}
        busy={busy}
        onClose={() => setActiveLead(null)}
        onClearRedirect={handleClearRedirect}
      />
    </div>
  );
}

interface LeadDetailsDrawerProps {
  lead: Lead | null;
  busy: boolean;
  onClose: () => void;
  onClearRedirect: (lead: Lead) => void;
}

function LeadDetailsDrawer({ lead, busy, onClose, onClearRedirect }: LeadDetailsDrawerProps) {
  // Close on Escape — drawers without it feel broken on desktop.
  useEffect(() => {
    if (!lead) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lead, onClose]);

  if (!lead) return null;

  const listedDomain = (lead.website_url || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  const initial = (lead.company_name || '?').charAt(0).toUpperCase();

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/40 z-40"
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label={`${lead.company_name} details`}
        className="fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[460px] bg-white shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-rose-50 flex items-center justify-center text-rose-600 font-extrabold text-base flex-shrink-0">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-extrabold text-on-surface truncate" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {lead.company_name}
            </p>
            <p className="text-[11px] text-secondary truncate">
              {lead.country ? `${lead.country} · ` : ''}{lead.category || 'no category'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-container transition-colors flex-shrink-0"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[18px] text-secondary">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Redirect callout — the headline reason this lead is on this page */}
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-amber-800 mb-1">Redirect detected</p>
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-900">
              <span className="truncate flex-1 min-w-0">{listedDomain || '—'}</span>
              <span className="material-symbols-outlined text-[14px] text-amber-700">arrow_forward</span>
              <span className="truncate flex-1 min-w-0">{lead.redirects_to || '—'}</span>
            </div>
          </div>

          {/* Snapshot fields */}
          <DetailRow label="Listed domain" value={listedDomain || '—'} />
          <DetailRow label="Redirects to" value={lead.redirects_to || '—'} />
          <DetailRow label="Country" value={lead.country || '—'} />
          <DetailRow label="Category" value={lead.category || '—'} />
          <DetailRow label="Rating" value={lead.star_rating != null ? `${lead.star_rating.toFixed(1)} ★` : '—'} />
          <DetailRow label="Outreach status" value={lead.outreach_status} />
          <DetailRow label="Phone" value={lead.phone || '—'} />
          <DetailRow label="Primary email" value={lead.primary_email || '—'} />
          <DetailRow label="Website email" value={lead.website_email || '—'} />
          <DetailRow
            label="Detected"
            value={lead.scraped_at ? new Date(lead.scraped_at).toLocaleString() : '—'}
          />

          {/* Tags */}
          {lead.tags && lead.tags.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-secondary mb-1.5">Tags</p>
              <div className="flex flex-wrap gap-1.5">
                {lead.tags.map((t) => (
                  <span key={t} className="text-[11px] font-semibold bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Screenshot — only render if we have one; defer-loaded via lazy
              attribute so the drawer paint isn't blocked on the network. */}
          {lead.screenshot_path && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-secondary mb-1.5">Trustpilot screenshot</p>
              <img
                src={lead.screenshot_path}
                alt={`${lead.company_name} Trustpilot profile`}
                loading="lazy"
                className="w-full rounded-lg border border-slate-200"
              />
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-3 border-t border-slate-100 bg-surface-container-low flex flex-col gap-2">
          {lead.trustpilot_url && (
            <a
              href={lead.trustpilot_url}
              target="_blank"
              rel="noreferrer"
              className="w-full text-center px-4 py-2 rounded-lg bg-white border border-slate-200 text-xs font-bold text-secondary hover:bg-surface-container transition-colors"
            >
              Open Trustpilot profile ↗
            </a>
          )}
          <button
            onClick={() => onClearRedirect(lead)}
            disabled={busy || !lead.redirects_to}
            className="w-full px-4 py-2 rounded-lg bg-rose-600 text-white text-xs font-bold disabled:opacity-40 hover:bg-rose-700 transition-colors"
            title="Same operator behind both domains? Replace the website with the redirect target and bring this lead back to the main pipeline."
          >
            Treat redirect target as canonical
          </button>
        </div>
      </aside>
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-slate-100 last:border-b-0">
      <span className="text-[11px] font-bold uppercase tracking-wider text-secondary flex-shrink-0">{label}</span>
      <span className="text-xs text-on-surface text-right min-w-0 break-words">{value}</span>
    </div>
  );
}

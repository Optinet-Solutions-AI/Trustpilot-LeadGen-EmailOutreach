'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLeads } from '../hooks/useLeads';
import api from '../api/client';

/**
 * Redirected Leads — leads whose website_url 30x'd to a different registrable
 * domain during enrichment. We deliberately hide them from the main Lead Matrix
 * because reaching out with the standard "I noticed your bad reviews on X" copy
 * doesn't make sense when the operator has already moved to a different brand.
 *
 * From this page, the user creates campaigns with redirect-aware copy
 * (e.g. "noticed Y now points to Z — are you still operating Y?") so the
 * lead isn't lost but also isn't mis-targeted.
 */
export default function RedirectedLeads() {
  const router = useRouter();
  const { leads, total, totalPages, loading, fetchLeads } = useLeads();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const loadLeads = useCallback(() => {
    const filters: Record<string, string | number> = {
      page,
      limit: 25,
      sortBy: 'scraped_at',
      sortDir: 'desc',
    };
    if (search) filters.search = search;
    (filters as any).redirected = 'only';
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
        <>
        {/* Mobile cards */}
        <div className="lg:hidden space-y-2">
          {leads.map((lead) => {
            const listedDomain = (lead.website_url || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
            const isChecked = selectedIds.includes(lead.id);
            return (
              <div
                key={lead.id}
                onClick={() => toggleSelect(lead.id)}
                className={`bg-white rounded-xl border p-3 flex gap-3 active:bg-slate-50 cursor-pointer ${isChecked ? 'border-rose-400 ring-1 ring-rose-200' : 'border-slate-100'}`}
              >
                <label className="flex items-start pt-1" onClick={(e) => e.stopPropagation()}>
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
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                    <a
                      href={lead.trustpilot_url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-[11px] text-rose-600"
                    >
                      Trustpilot ↗
                    </a>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleClearRedirect(lead); }}
                      disabled={busy}
                      className="text-[11px] text-slate-500 hover:text-slate-900 disabled:opacity-50"
                    >
                      clear flag
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop table */}
        <div className="hidden lg:block bg-white rounded-lg border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={selectedIds.length === leads.length && leads.length > 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Company</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Listed Domain</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Redirects To</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Country</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Rating</th>
                <th className="px-4 py-3 text-left font-medium text-slate-600">Detected</th>
                <th className="px-4 py-3 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
                const listedDomain = (lead.website_url || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
                return (
                  <tr key={lead.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(lead.id)}
                        onChange={() => toggleSelect(lead.id)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{lead.company_name}</div>
                      <a
                        href={lead.trustpilot_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-rose-600 hover:underline"
                      >
                        view on Trustpilot
                      </a>
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
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleClearRedirect(lead)}
                        disabled={busy}
                        className="text-xs text-slate-500 hover:text-slate-900"
                        title="Same operator behind both domains? Replace the website with the redirect target and bring this lead back to the main pipeline. Next enrich will run the full email ladder on the new domain."
                      >
                        clear flag
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
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

      {totalPages > 1 && (
        <div className="mt-4 flex justify-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1 border border-slate-200 rounded disabled:opacity-50"
          >
            Prev
          </button>
          <span className="px-3 py-1">{page} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1 border border-slate-200 rounded disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

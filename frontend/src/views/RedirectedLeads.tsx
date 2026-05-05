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

  const handleClearRedirect = async (leadId: string) => {
    // Clearing redirects_to brings the lead back into the main pipeline. Use
    // when the user has confirmed the redirect target IS the same operator
    // (rebrand) and wants to reach them under the new domain.
    if (!confirm('Move this lead back to the main pipeline? The redirect tag will be cleared.')) return;
    setBusy(true);
    try {
      await api.patch(`/leads/${leadId}`, { redirects_to: null });
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
    <div className="p-6 max-w-screen-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">
          Redirected <span className="text-rose-600">Leads</span>
        </h1>
        <p className="text-slate-600 mt-1">
          {total} {total === 1 ? 'lead' : 'leads'} whose websites redirect to a different brand. Outreach
          to these requires different messaging — don't run the standard cold-email template.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }}
          placeholder="Search company or domain…"
          className="flex-1 min-w-[280px] px-4 py-2 border border-slate-200 rounded-lg bg-white"
        />
        <button
          onClick={handleStartCampaign}
          disabled={selectedIds.length === 0 || busy}
          className="px-4 py-2 bg-rose-600 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
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
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
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
                        onClick={() => handleClearRedirect(lead.id)}
                        disabled={busy}
                        className="text-xs text-slate-500 hover:text-slate-900"
                        title="Same operator behind both domains? Clear the redirect tag and bring this lead back to the main pipeline."
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

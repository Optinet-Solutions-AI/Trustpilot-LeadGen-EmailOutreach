'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { GEO_FILTERS, SORT_OPTIONS } from '../components/affiliate-monitor/AffiliateData';
import type { Affiliate } from '../components/affiliate-monitor/AffiliateData';
import SummaryStats from '../components/affiliate-monitor/SummaryStats';
import DashboardToolbar from '../components/affiliate-monitor/DashboardToolbar';
import CountryOverview from '../components/affiliate-monitor/CountryOverview';
import AffiliateTable from '../components/affiliate-monitor/AffiliateTable';
import PageChartTable from '../components/affiliate-monitor/PageChartTable';
import JobProgress from '../components/JobProgress';
import { useAffiliates } from '../hooks/useAffiliates';
import { useCheckLinksJob } from '../hooks/useCheckLinksJob';
import api from '../api/client';

// ── Add Affiliate Modal ──────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: '',
  tp_url: '',
  website: '',
  description: '',
  geo: '',
  reviews: '',
  rating: '',
  warning: false,
};

interface AddModalProps {
  onClose: () => void;
  onSave: (payload: Omit<Affiliate, 'id' | 'created_at'>) => Promise<unknown>;
  onBulkSave: (text: string) => Promise<{ created: unknown[]; skipped: string[]; invalid: string[]; jobId: string | null }>;
  existingWebsites: Set<string>;
  onBulkDone: (result: { created: number; skipped: number; invalid: number; jobId: string | null }) => void;
}

const TP_REVIEW_LINE = /(^|\.)trustpilot\.com\/review\/([^/?#\s]+)/i;

function previewBulk(text: string, existing: Set<string>) {
  let detected = 0, tracked = 0, invalid = 0;
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(TP_REVIEW_LINE);
    if (!m) { invalid++; continue; }
    const site = m[2].toLowerCase().replace(/^www\./, '');
    if (existing.has(site) || seen.has(site)) { tracked++; continue; }
    seen.add(site);
    detected++;
  }
  return { detected, tracked, invalid };
}

function AddAffiliateModal({ onClose, onSave, onBulkSave, existingWebsites, onBulkDone }: AddModalProps) {
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [bulkText, setBulkText] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const preview = previewBulk(bulkText, existingWebsites);

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    try {
      const result = await onBulkSave(bulkText);
      onBulkDone({
        created: result.created.length,
        skipped: result.skipped.length,
        invalid: result.invalid.length,
        jobId: result.jobId,
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Bulk add failed');
    } finally {
      setSaving(false);
    }
  };

  const set = (key: keyof typeof EMPTY_FORM) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    try {
      await onSave({
        name: form.name.trim(),
        tp_url: form.tp_url.trim() || null,
        website: form.website.trim() || null,
        description: form.description.trim() || null,
        geo: form.geo
          .split(',')
          .map((g) => g.trim().toUpperCase())
          .filter(Boolean),
        reviews: form.reviews !== '' ? parseInt(form.reviews, 10) : null,
        rating: form.rating !== '' ? parseFloat(form.rating) : null,
        warning: form.warning,
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
            Add <span className="text-[#b0004a]">Affiliate</span>
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>

        {/* Single / Bulk toggle */}
        <div className="flex items-center gap-1 mb-5 bg-slate-100 rounded-lg p-1">
          {(['single', 'bulk'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setErr(null); }}
              className={`flex-1 px-3 py-1.5 rounded-md text-sm font-bold transition-colors ${
                mode === m ? 'bg-white text-[#b0004a] shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {m === 'single' ? 'Single' : 'Bulk paste'}
            </button>
          ))}
        </div>

        {mode === 'bulk' ? (
          <form onSubmit={handleBulkSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">Trustpilot URLs (one per line)</label>
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                rows={9}
                placeholder={'https://de.trustpilot.com/review/example.com\nhttps://au.trustpilot.com/review/another.net'}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-[#b0004a] transition-colors resize-none"
              />
              <p className="text-xs text-slate-400 mt-1.5">
                <span className="font-bold text-slate-600">{preview.detected}</span> to add
                {preview.tracked > 0 && <> · <span className="font-bold text-amber-600">{preview.tracked}</span> already tracked</>}
                {preview.invalid > 0 && <> · <span className="font-bold text-red-500">{preview.invalid}</span> invalid</>}
                <br />
                <span className="text-slate-400">Name, rating &amp; reviews are filled in automatically after adding.</span>
              </p>
            </div>

            {err && <p className="text-xs text-red-500">{err}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-bold text-slate-500 hover:bg-slate-100 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || preview.detected === 0}
                className="px-5 py-2 rounded-lg text-sm font-bold bg-[#b0004a] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {saving ? 'Adding…' : `Add ${preview.detected} Affiliate${preview.detected === 1 ? '' : 's'}`}
              </button>
            </div>
          </form>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">Name *</label>
            <input
              required
              value={form.name}
              onChange={set('name')}
              placeholder="e.g. SuppliesToBuy"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#b0004a] transition-colors"
            />
          </div>

          {/* TP Link */}
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">Trustpilot Link</label>
            <input
              value={form.tp_url}
              onChange={set('tp_url')}
              placeholder="au.trustpilot.com/review/example.com"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-[#b0004a] transition-colors"
            />
          </div>

          {/* Website */}
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">Website</label>
            <input
              value={form.website}
              onChange={set('website')}
              placeholder="example.com"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-[#b0004a] transition-colors"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={set('description')}
              rows={2}
              placeholder="Short description of the affiliate page"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#b0004a] transition-colors resize-none"
            />
          </div>

          {/* Geo + Reviews + Rating in a row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">Geo (comma-sep)</label>
              <input
                value={form.geo}
                onChange={set('geo')}
                placeholder="AU, DE"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#b0004a] transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">Reviews</label>
              <input
                type="number"
                min={0}
                value={form.reviews}
                onChange={set('reviews')}
                placeholder="136"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#b0004a] transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">Rating (0–5)</label>
              <input
                type="number"
                min={0}
                max={5}
                step={0.1}
                value={form.rating}
                onChange={set('rating')}
                placeholder="4.5"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#b0004a] transition-colors"
              />
            </div>
          </div>

          {/* Warning toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.warning}
              onChange={(e) => setForm((f) => ({ ...f, warning: e.target.checked }))}
              className="accent-[#b0004a] w-4 h-4"
            />
            <span className="text-sm text-slate-600">Flag as fake / suspicious domain</span>
          </label>

          {err && <p className="text-xs text-red-500">{err}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-bold text-slate-500 hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-lg text-sm font-bold bg-[#b0004a] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {saving ? 'Saving…' : 'Add Affiliate'}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}

// ── Main View ────────────────────────────────────────────────────────────────

export default function AffiliateMonitor() {
  const { affiliates, loading, error, fetchAffiliates, addAffiliate, bulkAddAffiliates, bulkDelete, updateAffiliate } = useAffiliates();
  const [activeTab, setActiveTab] = useState<'chart' | 'dashboard'>('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [geoFilter, setGeoFilter] = useState('All');
  const [sortBy, setSortBy] = useState('reviews_desc');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddModal, setShowAddModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [bulkSummary, setBulkSummary] = useState<{ created: number; skipped: number; invalid: number } | null>(null);

  useEffect(() => {
    fetchAffiliates();
  }, [fetchAffiliates]);

  // Clear selection when tab changes
  useEffect(() => { setSelectedIds(new Set()); }, [activeTab]);

  const filteredData = useMemo(() => {
    let d = [...affiliates];
    const q = searchQuery.toLowerCase();
    if (q) {
      d = d.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.website ?? '').toLowerCase().includes(q) ||
          r.geo.join(' ').toLowerCase().includes(q) ||
          (r.description ?? '').toLowerCase().includes(q)
      );
    }
    if (geoFilter !== 'All') {
      d = d.filter((r) => r.geo.includes(geoFilter));
    }
    if (sortBy === 'reviews_desc') d.sort((a, b) => (b.reviews || 0) - (a.reviews || 0));
    else if (sortBy === 'reviews_asc') d.sort((a, b) => (a.reviews || 0) - (b.reviews || 0));
    else if (sortBy === 'alpha') d.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'geo') d.sort((a, b) => (a.geo[0] ?? '').localeCompare(b.geo[0] ?? ''));
    return d;
  }, [affiliates, searchQuery, geoFilter, sortBy]);

  const stats = useMemo(() => {
    const live = affiliates.filter((r) => !r.warning);
    const totalReviews = affiliates.reduce((sum, r) => sum + (r.reviews || 0), 0);
    const geos = new Set(affiliates.flatMap((r) => r.geo));
    const rated = affiliates.filter((r) => r.rating != null);
    const avgRating =
      rated.length > 0
        ? (rated.reduce((sum, r) => sum + (r.rating || 0), 0) / rated.length).toFixed(1)
        : '0';
    return { livePages: live.length, totalReviews, geoMarkets: geos.size, avgRating };
  }, [affiliates]);

  const existingWebsites = useMemo(
    () => new Set(affiliates.map((a) => (a.website ?? '').toLowerCase().replace(/^www\./, '')).filter(Boolean)),
    [affiliates],
  );

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    const visibleIds = filteredData.map((e) => e.id);
    const allSelected = visibleIds.every((id) => selectedIds.has(id));
    setSelectedIds(() => {
      if (allSelected) return new Set();
      return new Set(visibleIds);
    });
  }, [filteredData, selectedIds]);

  const handleDelete = async (id: string) => {
    const confirmed = window.confirm('Delete this affiliate? This cannot be undone.');
    if (!confirmed) return;
    setDeleting(true);
    try {
      await bulkDelete([id]);
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    } finally {
      setDeleting(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const confirmed = window.confirm(
      `Delete ${selectedIds.size} affiliate${selectedIds.size > 1 ? 's' : ''}? This cannot be undone.`
    );
    if (!confirmed) return;
    setDeleting(true);
    try {
      await bulkDelete([...selectedIds]);
      setSelectedIds(new Set());
    } finally {
      setDeleting(false);
    }
  };

  // ── Validate Links — same SSE-driven job pattern as the Lead Matrix ──────
  const [linkJobId, setLinkJobId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('active_affiliate_link_job');
  });
  const [linkStartedAt, setLinkStartedAt] = useState<string | null>(null);
  const [linkResult, setLinkResult] = useState<{ total: number; valid: number; dead: number; removed: number; unknown: number } | null>(null);
  const linkJob = useCheckLinksJob(linkJobId, 'affiliates');
  const checkingLinks = linkJob.status === 'running';

  const handleBulkCheckLinks = async () => {
    if (selectedIds.size === 0) return;
    // Guard against double-click — a second job would launch a second
    // Chromium browser and starve the first one of memory.
    if (checkingLinks || linkJobId) {
      window.alert('A link-validation job is already running. Wait for it to finish.');
      return;
    }
    try {
      const ids = [...selectedIds];
      const res = await api.post('/affiliates/check-links', { ids });
      const { jobId } = res.data.data;
      if (!jobId) return;
      localStorage.setItem('active_affiliate_link_job', jobId);
      setLinkJobId(jobId);
      setLinkStartedAt(new Date().toISOString());
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to start link validation');
    }
  };

  useEffect(() => {
    if (!linkJobId) return;
    if (linkJob.status === 'completed') {
      setLinkResult({
        total: linkJob.summary.total,
        valid: linkJob.summary.valid,
        dead: linkJob.summary.flagged_dead,
        removed: linkJob.summary.flagged_removed,
        unknown: linkJob.summary.unknown,
      });
      setLinkJobId(null);
      setLinkStartedAt(null);
      localStorage.removeItem('active_affiliate_link_job');
      fetchAffiliates();
    } else if (linkJob.status === 'failed') {
      setLinkJobId(null);
      setLinkStartedAt(null);
      localStorage.removeItem('active_affiliate_link_job');
    }
  }, [linkJob.status, linkJob.summary, linkJobId, fetchAffiliates]);

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-8 xl:px-10 xl:py-10 space-y-4 sm:space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div>
          <h2
            className="text-2xl sm:text-4xl font-extrabold tracking-tight text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Affiliate <span className="text-[#b0004a]">Monitor</span>
          </h2>
          <p className="text-slate-400 text-sm mt-1 sm:mt-2">
            {affiliates.length} Trustpilot affiliate pages tracked
            {loading && <span className="ml-2 text-slate-300">· loading…</span>}
          </p>
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold bg-[#b0004a] text-white hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          Add Affiliate
        </button>
      </div>

      {/* Tab Toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setActiveTab('dashboard')}
          className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-colors ${
            activeTab === 'dashboard'
              ? 'bg-[#ffd9de] text-[#b0004a]'
              : 'bg-surface-container text-secondary hover:bg-surface-container-high'
          }`}
        >
          <span className="material-symbols-outlined text-[18px]">dashboard</span>
          Full Dashboard
        </button>
        <button
          onClick={() => setActiveTab('chart')}
          className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-colors ${
            activeTab === 'chart'
              ? 'bg-[#ffd9de] text-[#b0004a]'
              : 'bg-surface-container text-secondary hover:bg-surface-container-high'
          }`}
        >
          <span className="material-symbols-outlined text-[18px]">table_chart</span>
          Page Chart
        </button>

        {/* Validate Links — visible when items are checked */}
        {selectedIds.size > 0 && (
          <button
            onClick={handleBulkCheckLinks}
            disabled={checkingLinks || deleting}
            className="ml-auto inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 transition-colors"
            title="Re-checks each affiliate's Trustpilot URL for dead/removed pages"
          >
            <span className={`material-symbols-outlined text-[18px] ${checkingLinks ? 'animate-spin' : ''}`}>
              {checkingLinks ? 'progress_activity' : 'link'}
            </span>
            {checkingLinks ? 'Validating…' : `Validate Links (${selectedIds.size})`}
          </button>
        )}

        {/* Delete Selected — visible when items are checked */}
        {selectedIds.size > 0 && (
          <button
            onClick={handleBulkDelete}
            disabled={deleting || checkingLinks}
            className={`${selectedIds.size > 0 ? '' : 'ml-auto'} inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors`}
          >
            <span className="material-symbols-outlined text-[18px]">delete</span>
            {deleting ? 'Deleting…' : `Delete Selected (${selectedIds.size})`}
          </button>
        )}
      </div>

      {/* Live link-check progress — inline log panel */}
      {linkJobId && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6">
          <JobProgress
            kind="check-links"
            status={linkJob.status === 'idle' ? 'running' : linkJob.status}
            progress={linkJob.progress}
            error={linkJob.error}
            startedAt={linkStartedAt}
          />
        </div>
      )}

      {/* Bulk-add summary banner */}
      {bulkSummary && (
        <div className="flex items-center gap-3 rounded-xl px-5 py-3 text-sm border bg-[#8ff9a8]/20 border-[#006630]/20 text-[#006630]">
          <span className="material-symbols-outlined text-[18px] text-[#006630]">playlist_add_check</span>
          <span className="font-semibold">Bulk add complete!</span>
          <span className="font-normal">
            Added <strong>{bulkSummary.created}</strong>
            {bulkSummary.skipped > 0 && <>, skipped <strong>{bulkSummary.skipped}</strong> already tracked</>}
            {bulkSummary.invalid > 0 && <>, <strong>{bulkSummary.invalid}</strong> invalid</>}
            . Enriching name, rating &amp; reviews now…
          </span>
          <button onClick={() => setBulkSummary(null)} className="ml-auto text-[#006630]/60 hover:text-[#006630] transition-colors">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Link-check result banner */}
      {linkResult && (
        <div className={`flex items-center gap-3 rounded-xl px-5 py-3 text-sm border ${
          (linkResult.dead + linkResult.removed) > 0
            ? 'bg-amber-50 border-amber-200 text-amber-800'
            : 'bg-[#8ff9a8]/20 border-[#006630]/20 text-[#006630]'
        }`}>
          <span className={`material-symbols-outlined text-[18px] ${(linkResult.dead + linkResult.removed) > 0 ? 'text-amber-600' : 'text-[#006630]'}`}>
            {(linkResult.dead + linkResult.removed) > 0 ? 'warning' : 'check_circle'}
          </span>
          <span className="font-semibold">Link validation complete!</span>
          <span className="font-normal">
            <strong>{linkResult.valid}</strong> valid, <strong>{linkResult.dead}</strong> dead, <strong>{linkResult.removed}</strong> removed, <strong>{linkResult.unknown}</strong> unknown out of <strong>{linkResult.total}</strong> URL{linkResult.total !== 1 ? 's' : ''}.
          </span>
          <button
            onClick={() => setLinkResult(null)}
            className={`ml-auto transition-colors ${(linkResult.dead + linkResult.removed) > 0 ? 'text-amber-600/60 hover:text-amber-800' : 'text-[#006630]/60 hover:text-[#006630]'}`}
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Content */}
      {activeTab === 'chart' && (
        <PageChartTable
          data={filteredData}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onToggleAll={handleToggleAll}
          onDelete={handleDelete}
          onUpdate={updateAffiliate}
        />
      )}

      {activeTab === 'dashboard' && (
        <>
          <SummaryStats
            livePages={stats.livePages}
            totalReviews={stats.totalReviews}
            geoMarkets={stats.geoMarkets}
            avgRating={stats.avgRating}
          />
          <DashboardToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            geoFilter={geoFilter}
            onGeoFilterChange={setGeoFilter}
            sortBy={sortBy}
            onSortChange={setSortBy}
          />
          <CountryOverview data={affiliates} onFilterClick={setGeoFilter} />
          <AffiliateTable
            data={filteredData}
            expandedId={expandedId}
            onToggleExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
            totalCount={affiliates.length}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleAll={handleToggleAll}
            onDelete={handleDelete}
            onUpdate={updateAffiliate}
          />
        </>
      )}

      {showAddModal && (
        <AddAffiliateModal
          onClose={() => setShowAddModal(false)}
          onSave={addAffiliate}
          onBulkSave={bulkAddAffiliates}
          existingWebsites={existingWebsites}
          onBulkDone={({ created, skipped, invalid, jobId }) => {
            setBulkSummary({ created, skipped, invalid });
            // Stream the enrichment job through the existing link-job machinery
            // so name/rating/reviews + link badges populate live, then refetch.
            if (jobId) {
              localStorage.setItem('active_affiliate_link_job', jobId);
              setLinkJobId(jobId);
              setLinkStartedAt(new Date().toISOString());
            }
          }}
        />
      )}
    </div>
  );
}

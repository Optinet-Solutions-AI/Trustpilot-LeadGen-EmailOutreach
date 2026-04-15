'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { GEO_FILTERS, SORT_OPTIONS } from '../components/affiliate-monitor/AffiliateData';
import type { Affiliate } from '../components/affiliate-monitor/AffiliateData';
import SummaryStats from '../components/affiliate-monitor/SummaryStats';
import DashboardToolbar from '../components/affiliate-monitor/DashboardToolbar';
import CountryOverview from '../components/affiliate-monitor/CountryOverview';
import AffiliateTable from '../components/affiliate-monitor/AffiliateTable';
import PageChartTable from '../components/affiliate-monitor/PageChartTable';
import { useAffiliates } from '../hooks/useAffiliates';

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
}

function AddAffiliateModal({ onClose, onSave }: AddModalProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
            Add <span className="text-[#b0004a]">Affiliate</span>
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>

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
      </div>
    </div>
  );
}

// ── Main View ────────────────────────────────────────────────────────────────

export default function AffiliateMonitor() {
  const { affiliates, loading, error, fetchAffiliates, addAffiliate, bulkDelete } = useAffiliates();
  const [activeTab, setActiveTab] = useState<'chart' | 'dashboard'>('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [geoFilter, setGeoFilter] = useState('All');
  const [sortBy, setSortBy] = useState('reviews_desc');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddModal, setShowAddModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  return (
    <div className="px-10 py-10 space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            className="text-4xl font-extrabold tracking-tight text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Affiliate <span className="text-[#b0004a]">Monitor</span>
          </h2>
          <p className="text-slate-400 text-sm mt-2">
            {affiliates.length} Trustpilot affiliate pages tracked
            {loading && <span className="ml-2 text-slate-300">· loading…</span>}
          </p>
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold bg-[#b0004a] text-white hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
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

        {/* Delete Selected — visible when items are checked */}
        {selectedIds.size > 0 && (
          <button
            onClick={handleBulkDelete}
            disabled={deleting}
            className="ml-auto inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">delete</span>
            {deleting ? 'Deleting…' : `Delete Selected (${selectedIds.size})`}
          </button>
        )}
      </div>

      {/* Content */}
      {activeTab === 'chart' && (
        <PageChartTable
          data={filteredData}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onToggleAll={handleToggleAll}
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
          />
        </>
      )}

      {showAddModal && (
        <AddAffiliateModal
          onClose={() => setShowAddModal(false)}
          onSave={addAffiliate}
        />
      )}
    </div>
  );
}

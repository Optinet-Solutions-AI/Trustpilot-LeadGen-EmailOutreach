'use client';

import { useState, useMemo } from 'react';
import { AFFILIATE_DATA } from '../components/affiliate-monitor/AffiliateData';
import SummaryStats from '../components/affiliate-monitor/SummaryStats';
import DashboardToolbar from '../components/affiliate-monitor/DashboardToolbar';
import CountryOverview from '../components/affiliate-monitor/CountryOverview';
import AffiliateTable from '../components/affiliate-monitor/AffiliateTable';
import PageChartTable from '../components/affiliate-monitor/PageChartTable';

export default function AffiliateMonitor() {
  const [activeTab, setActiveTab] = useState<'chart' | 'dashboard'>('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [geoFilter, setGeoFilter] = useState('All');
  const [sortBy, setSortBy] = useState('reviews_desc');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const filteredData = useMemo(() => {
    let d = [...AFFILIATE_DATA];

    const q = searchQuery.toLowerCase();
    if (q) {
      d = d.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.website.toLowerCase().includes(q) ||
          r.geo.join(' ').toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q)
      );
    }

    if (geoFilter !== 'All') {
      d = d.filter((r) => r.geo.includes(geoFilter));
    }

    if (sortBy === 'reviews_desc') d.sort((a, b) => (b.reviews || 0) - (a.reviews || 0));
    else if (sortBy === 'reviews_asc') d.sort((a, b) => (a.reviews || 0) - (b.reviews || 0));
    else if (sortBy === 'alpha') d.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'geo') d.sort((a, b) => a.geo[0].localeCompare(b.geo[0]));

    return d;
  }, [searchQuery, geoFilter, sortBy]);

  const stats = useMemo(() => {
    const live = AFFILIATE_DATA.filter((r) => !r.warning);
    const totalReviews = AFFILIATE_DATA.reduce((sum, r) => sum + (r.reviews || 0), 0);
    const geos = new Set(AFFILIATE_DATA.flatMap((r) => r.geo));
    const rated = AFFILIATE_DATA.filter((r) => r.rating != null);
    const avgRating =
      rated.length > 0
        ? (rated.reduce((sum, r) => sum + (r.rating || 0), 0) / rated.length).toFixed(1)
        : '0';
    return {
      livePages: live.length,
      totalReviews,
      geoMarkets: geos.size,
      avgRating,
    };
  }, []);

  const handleToggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const handleGeoFilter = (geo: string) => {
    setGeoFilter(geo);
  };

  return (
    <div className="px-10 py-10 space-y-8">
      {/* Header */}
      <div>
        <h2
          className="text-4xl font-extrabold tracking-tight text-on-surface"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Affiliate <span className="text-[#b0004a]">Monitor</span>
        </h2>
        <p className="text-slate-400 text-sm mt-2">
          {AFFILIATE_DATA.length} Trustpilot affiliate pages tracked &middot; last synced March 2026
        </p>
      </div>

      {/* Tab Toggle */}
      <div className="flex gap-2">
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
      </div>

      {/* Content */}
      {activeTab === 'chart' && <PageChartTable data={AFFILIATE_DATA} />}

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
            onGeoFilterChange={handleGeoFilter}
            sortBy={sortBy}
            onSortChange={setSortBy}
          />
          <CountryOverview data={AFFILIATE_DATA} onFilterClick={handleGeoFilter} />
          <AffiliateTable
            data={filteredData}
            expandedId={expandedId}
            onToggleExpand={handleToggleExpand}
            totalCount={AFFILIATE_DATA.length}
          />
        </>
      )}
    </div>
  );
}

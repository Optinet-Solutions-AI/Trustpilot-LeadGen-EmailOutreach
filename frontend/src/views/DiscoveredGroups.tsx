'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDiscoveredGroups, DiscoveredGroup } from '../hooks/useDiscoveredGroups';
import { useScrape } from '../hooks/useScrape';
import type { FacebookGroupScrapeParams } from '../components/ScrapeForm';
import Button from '../ui/Button';
import Card from '../ui/Card';
import Pill from '../ui/Pill';
import SectionHeader from '../ui/SectionHeader';

type AudienceFilter = 'all' | 'customers' | 'trades' | 'unclear' | 'unlabelled';

const AUDIENCE_META: Record<string, { label: string; variant: 'success' | 'error' | 'info' | 'neutral' }> = {
  customers: { label: 'Customers', variant: 'success' },
  trades: { label: 'Trades', variant: 'error' },
  unclear: { label: 'Unclear', variant: 'info' },
};

const FILTER_TABS: Array<{ value: AudienceFilter; label: string }> = [
  { value: 'all', label: 'All groups' },
  { value: 'customers', label: 'Customers' },
  { value: 'trades', label: 'Trades' },
  { value: 'unclear', label: 'Unclear' },
  { value: 'unlabelled', label: 'Unlabelled' },
];

function relativeFromNow(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'Never';
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export default function DiscoveredGroups() {
  const { rows, loading, error, labelUnlabelled, labelling, labelResult } = useDiscoveredGroups();
  const { startScrape } = useScrape();
  const router = useRouter();

  const [audienceFilter, setAudienceFilter] = useState<AudienceFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [niche, setNiche] = useState('');
  const [location, setLocation] = useState('');
  const [groupKeyword, setGroupKeyword] = useState('recommend');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const unlabelledCount = rows.filter((r) => !r.audience).length;

  const filtered = useMemo(() => {
    if (audienceFilter === 'all') return rows;
    if (audienceFilter === 'unlabelled') return rows.filter((r) => !r.audience);
    return rows.filter((r) => r.audience === audienceFilter);
  }, [rows, audienceFilter]);

  const selectedRows = rows.filter((r) => selected.has(r.id));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const allVisibleSelected = filtered.length > 0 && filtered.every((r) => prev.has(r.id));
      if (allVisibleSelected) {
        const next = new Set(prev);
        filtered.forEach((r) => next.delete(r.id));
        return next;
      }
      const next = new Set(prev);
      filtered.forEach((r) => next.add(r.id));
      return next;
    });
  };

  const handleStartScrape = async () => {
    if (selectedRows.length === 0) return;
    if (!niche.trim()) {
      setStartError('Niche is required — the scraper needs it to build a search phrase and tag leads.');
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const group_urls = selectedRows.map((r) => `https://www.facebook.com/groups/${r.group_id}`);
      const params: FacebookGroupScrapeParams = {
        platform: 'facebook',
        lead_type: 'consumers',
        niche: niche.trim(),
        location: location.trim() || undefined,
        group_urls,
        group_keyword: groupKeyword.trim() || undefined,
        enrich: false,
        verify: false,
        forceRescrape: false,
      };
      const id = await startScrape(params);
      if (id) {
        router.push('/scrape');
      } else {
        setStartError('Failed to start the scrape — see the Scrape page for details.');
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-8 xl:px-10 xl:py-10 space-y-4 sm:space-y-6">
      <SectionHeader
        title="Discovered Groups"
        accent="Facebook"
        subtitle="Every Facebook group we've captured a post from, ranked by how many posts we've seen. No group URLs to paste — pick a few below and start a scrape."
        actions={
          <div className="flex items-center gap-2">
            {labelResult && (
              <Pill variant="success" size="sm">
                Labelled {labelResult.labelled}
              </Pill>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void labelUnlabelled()}
              disabled={labelling || unlabelledCount === 0}
              loading={labelling}
            >
              {labelling
                ? 'Labelling…'
                : unlabelledCount > 0
                  ? `Label ${unlabelledCount} new group${unlabelledCount === 1 ? '' : 's'}`
                  : 'All groups labelled'}
            </Button>
          </div>
        }
      />

      {error && (
        <div className="px-4 py-3 rounded-lg bg-error-container text-error text-sm font-medium">{error}</div>
      )}

      <Card variant="flush">
        <div className="px-4 sm:px-6 pt-3 pb-1 flex flex-wrap gap-2 border-b border-slate-100">
          {FILTER_TABS.map((t) => {
            const active = audienceFilter === t.value;
            const count =
              t.value === 'all' ? rows.length
              : t.value === 'unlabelled' ? unlabelledCount
              : rows.filter((r) => r.audience === t.value).length;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => setAudienceFilter(t.value)}
                className={
                  'px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ' +
                  (active ? 'bg-[#b0004a] text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')
                }
              >
                {t.label} <span className="opacity-70">({count})</span>
              </button>
            );
          })}
        </div>

        {loading && <p className="px-6 py-8 text-slate-500 text-sm">Loading…</p>}
        {!loading && filtered.length === 0 && (
          <p className="px-6 py-8 text-slate-400 text-sm">No groups match this filter.</p>
        )}

        {!loading && filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && filtered.every((r) => selected.has(r.id))}
                      onChange={toggleAllVisible}
                      aria-label="Select all visible groups"
                    />
                  </th>
                  {['Group', 'Location', 'Audience', 'Posts', 'Last seen', 'Status'].map((h) => (
                    <th key={h} className="px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-slate-400">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((r: DiscoveredGroup) => {
                  const meta = r.audience ? AUDIENCE_META[r.audience] : null;
                  return (
                    <tr
                      key={r.id}
                      className={`transition-colors ${selected.has(r.id) ? 'bg-[#ffd9de]/20' : 'hover:bg-surface-container/40'}`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggle(r.id)}
                          aria-label={`Select ${r.name || r.group_id}`}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={`https://www.facebook.com/groups/${r.group_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#b0004a] font-semibold hover:underline"
                        >
                          {r.name || r.group_id}
                        </a>
                        {r.niche && <div className="text-[11px] text-slate-400 mt-0.5">{r.niche}</div>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{r.location || '—'}</td>
                      <td className="px-4 py-3">
                        {meta ? (
                          <Pill variant={meta.variant} size="sm">{meta.label}</Pill>
                        ) : (
                          <Pill variant="neutral" size="sm">Unlabelled</Pill>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-bold text-on-surface">{r.post_count}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-secondary whitespace-nowrap">
                        {relativeFromNow(r.last_post_seen)}
                      </td>
                      <td className="px-4 py-3">
                        <Pill variant={r.status === 'joined' ? 'success' : 'neutral'} size="sm">{r.status}</Pill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedRows.length > 0 && (
        <Card
          header={
            <h3 className="font-bold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Start a scrape from {selectedRows.length} selected group{selectedRows.length === 1 ? '' : 's'}
            </h3>
          }
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="dg-niche">
                Niche / service <span className="text-error">*</span>
              </label>
              <input
                id="dg-niche"
                type="text"
                placeholder="plumber, electrician, handyman…"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="dg-location">
                Location <span className="text-on-surface-variant font-normal">(optional — tags lead country only)</span>
              </label>
              <input
                id="dg-location"
                type="text"
                placeholder="e.g. Bristol"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="dg-keyword">
                Group keyword filter
              </label>
              <input
                id="dg-keyword"
                type="text"
                value={groupKeyword}
                onChange={(e) => setGroupKeyword(e.target.value)}
                className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>

          {startError && (
            <div className="mb-3 px-4 py-2.5 rounded-lg bg-error-container text-error text-sm font-medium">
              {startError}
            </div>
          )}

          <Button variant="primary" size="md" onClick={() => void handleStartScrape()} loading={starting}>
            {starting ? 'Starting…' : `Start scrape with ${selectedRows.length} group${selectedRows.length === 1 ? '' : 's'}`}
          </Button>
        </Card>
      )}
    </div>
  );
}

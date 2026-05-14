'use client';

import { useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ScrapeParams, TripAdvisorScrapeParams, TrustpilotScrapeParams } from '../types/scrape';
import CountryPicker from './CountryPicker';
import CategoryPicker from './CategoryPicker';
import PlatformPicker, { type PlatformManifest } from './PlatformPicker';
import Button from '../ui/Button';
import Toggle from '../ui/Toggle';
import RangeInput from '../ui/RangeInput';
import Combobox from '../ui/Combobox';

interface Props {
  onSubmit: (params: ScrapeParams) => void;
  loading?: boolean;
}

const LISTING_TYPE_OPTIONS = [
  { value: 'hotels',      label: 'Hotels' },
  { value: 'restaurants', label: 'Restaurants' },
  { value: 'attractions', label: 'Attractions' },
];

export default function ScrapeForm({ onSubmit, loading }: Props) {
  const [platform, setPlatform] = useState<'trustpilot' | 'tripadvisor'>('trustpilot');
  const [activeManifest, setActiveManifest] = useState<PlatformManifest | null>(null);

  // Trustpilot fields
  const [country, setCountry] = useState('US');
  const [category, setCategory] = useState('casino');
  const [minRating, setMinRating] = useState(1.0);
  const [maxRating, setMaxRating] = useState(3.5);

  // TripAdvisor fields
  const [locationId, setLocationId] = useState('');
  const [locationSlug, setLocationSlug] = useState('');
  const [listingType, setListingType] = useState<'hotels' | 'restaurants' | 'attractions'>('hotels');
  const [taMinRating, setTaMinRating] = useState(1.0);
  const [taMaxRating, setTaMaxRating] = useState(3.0);

  // Shared flags
  const [enrich, setEnrich] = useState(false);
  const [verify, setVerify] = useState(false);
  const [forceRescrape, setForceRescrape] = useState(false);

  // Synchronous click-lock so a burst of clicks can't queue multiple POSTs
  // before the parent's loading state has propagated.
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || loading) return;

    let params: ScrapeParams;
    if (platform === 'tripadvisor') {
      if (!locationId.trim() || !locationSlug.trim()) {
        // Surface as a native form error rather than failing on POST
        alert('TripAdvisor requires both a geo ID and a location slug.');
        return;
      }
      params = {
        platform: 'tripadvisor',
        location_id: locationId.trim(),
        location_slug: locationSlug.trim(),
        listing_type: listingType,
        min_rating: taMinRating,
        max_rating: taMaxRating,
        enrich,
        verify,
        forceRescrape,
      } satisfies TripAdvisorScrapeParams;
    } else {
      params = {
        country,
        category,
        minRating,
        maxRating,
        enrich,
        verify,
        forceRescrape,
      } satisfies TrustpilotScrapeParams;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      onSubmit(params);
    } finally {
      setTimeout(() => {
        submittingRef.current = false;
        setIsSubmitting(false);
      }, 1500);
    }
  };

  const busy = !!(loading || isSubmitting);
  const showProxyHint = activeManifest?.name === platform && activeManifest?.requires_proxy;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="scrape-platform">
            Platform
          </label>
          <PlatformPicker
            id="scrape-platform"
            value={platform}
            onChange={(name, manifest) => {
              setPlatform(name as 'trustpilot' | 'tripadvisor');
              setActiveManifest(manifest);
            }}
            disabled={busy}
            onManifests={(ms) => {
              const m = ms.find((mm) => mm.name === platform);
              if (m) setActiveManifest(m);
            }}
          />
          {showProxyHint && (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              This platform blocks Cloud Run / EC2 IPs. Run from local mode.
            </p>
          )}
        </div>

        {platform === 'trustpilot' && (
          <>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="scrape-country">
                Country
              </label>
              <CountryPicker id="scrape-country" value={country} onChange={setCountry} disabled={busy} />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="scrape-category">
                Category
              </label>
              <CategoryPicker id="scrape-category" value={category} onChange={setCategory} disabled={busy} />
            </div>
            <RangeInput
              label="Star rating"
              suffix="★"
              value={[minRating, maxRating]}
              onChange={([lo, hi]) => {
                setMinRating(lo);
                setMaxRating(hi);
              }}
              min={1}
              max={5}
              step={0.5}
              disabled={busy}
            />
          </>
        )}

        {platform === 'tripadvisor' && (
          <>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="ta-geo">
                Geo ID
              </label>
              <input
                id="ta-geo"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                disabled={busy}
                placeholder="e.g. 60745"
                className="w-full rounded-md border border-divider bg-surface px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <p className="mt-1 text-[11px] text-on-surface-muted">
                From a TripAdvisor URL like Hotels-g<strong>60745</strong>-Boston…
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="ta-slug">
                Location slug
              </label>
              <input
                id="ta-slug"
                value={locationSlug}
                onChange={(e) => setLocationSlug(e.target.value)}
                disabled={busy}
                placeholder="e.g. Boston_Massachusetts"
                className="w-full rounded-md border border-divider bg-surface px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <p className="mt-1 text-[11px] text-on-surface-muted">
                The URL-safe location name from the same URL.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="ta-type">
                Listing type
              </label>
              <Combobox
                id="ta-type"
                value={listingType}
                onChange={(v) => setListingType(v as 'hotels' | 'restaurants' | 'attractions')}
                options={LISTING_TYPE_OPTIONS}
                placeholder="Pick a listing type"
                disabled={busy}
              />
            </div>
            <RangeInput
              label="Bubble rating"
              suffix="★"
              value={[taMinRating, taMaxRating]}
              onChange={([lo, hi]) => {
                setTaMinRating(lo);
                setTaMaxRating(hi);
              }}
              min={1}
              max={5}
              step={0.5}
              disabled={busy}
            />
          </>
        )}
      </div>

      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:gap-6">
        <Toggle
          checked={enrich}
          onChange={(e) => setEnrich(e.target.checked)}
          disabled={busy}
          label="Enrich from websites"
          description="Visit each company's site to find a primary email"
        />
        <Toggle
          checked={verify}
          onChange={(e) => setVerify(e.target.checked)}
          disabled={busy}
          label="Verify emails"
          description="Run ZeroBounce on each discovered email"
        />
        <Toggle
          checked={forceRescrape}
          onChange={(e) => setForceRescrape(e.target.checked)}
          disabled={busy}
          label="Force re-scrape"
          description="Bypass the duplicate-job guard"
        />
      </div>

      <div className="pt-1">
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={busy}
          leadingIcon={<Search size={16} />}
        >
          {busy ? 'Scraping…' : 'Start scrape'}
        </Button>
      </div>
    </form>
  );
}

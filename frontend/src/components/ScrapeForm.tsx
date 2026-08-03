'use client';

import { useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ScrapeParams, TripAdvisorScrapeParams, TrustpilotScrapeParams, YelpScrapeParams, FacebookScrapeParams } from '../types/scrape';
import CountryPicker from './CountryPicker';
import LocationPicker from './LocationPicker';
import NichePicker from './NichePicker';
import ComboWarning from './ComboWarning';
import CategoryPicker from './CategoryPicker';
import PlatformPicker, { type PlatformManifest } from './PlatformPicker';
import Button from '../ui/Button';
import Toggle from '../ui/Toggle';
import RangeInput from '../ui/RangeInput';
import Combobox from '../ui/Combobox';
import ScrapeCostAdvisory from './ScrapeCostAdvisory';

// Outreach country scope. Restricts the Trustpilot, TripAdvisor, Yelp,
// and FB businesses country dropdowns to the same set that maps cleanly
// onto the country-mismatch group filter in
// tools/scraper/platforms/facebook.py. Covers full Europe + United States.
// Keep these ISO codes in sync with CITY_TO_COUNTRY + _COUNTRY_NAME_TOKENS
// in that Python file.
const OUTREACH_COUNTRY_CODES = [
  // Western & Central Europe
  'GB', 'IE',
  'DE', 'FR', 'ES', 'IT',
  'NL', 'BE', 'LU', 'PT', 'CH', 'AT',
  // Central-Eastern Europe
  'CZ', 'PL', 'SK', 'HU', 'RO', 'BG',
  // Nordics
  'SE', 'DK', 'NO', 'FI', 'IS',
  // Balkans
  'HR', 'SI', 'RS', 'BA', 'AL', 'MK', 'ME',
  // Baltics + Moldova + Ukraine
  'LT', 'LV', 'EE', 'MD', 'UA',
  // Southern fringe
  'GR', 'MT', 'CY', 'TR',
  // North America
  'US',
];

/**
 * Default FB consumer-mode search phrase.
 *
 * Intent-shaped, NOT geo-stuffed. Measured 2026-08-03 on live Apify data
 * (open-feed post search, 20 results): the old geo-stuffed phrasing
 * "looking for a plumber in Manchester" returned 0 usable consumer asks out
 * of 20 — every hit was an advert — while intent phrasing such as
 * "need a plumber recommendation" returned genuine consumer asks. Query
 * phrasing is the single biggest lever on cost per lead, so keep the shape
 * intent-first and leave the geography to the `location` filter (which still
 * drives group/country scoping and the Gemini location match).
 *
 * Mirror of `defaultFbConsumerQuery` in server/src/services/social-routing.ts
 * (the server-side fallback used when a submitted job carries no query) — the
 * frontend cannot import server code, so keep the two identical.
 */
export function defaultFbQuery(niche: string, location = ''): string {
  const n = niche.trim().replace(/\s+/g, ' ');
  if (n) return `need a ${n} recommendation`;
  // No niche: fall back to the bare location rather than emitting
  // "need a recommendation", which matches nothing useful.
  return location.trim().replace(/\s+/g, ' ');
}

interface Props {
  onSubmit: (params: ScrapeParams) => void;
  loading?: boolean;
}

const LISTING_TYPE_OPTIONS = [
  { value: 'hotels',      label: 'Hotels' },
  { value: 'restaurants', label: 'Restaurants' },
  { value: 'attractions', label: 'Attractions' },
];

type SupportedPlatform = 'trustpilot' | 'tripadvisor' | 'yelp' | 'facebook';

export default function ScrapeForm({ onSubmit, loading }: Props) {
  const [platform, setPlatform] = useState<SupportedPlatform>('trustpilot');
  const [activeManifest, setActiveManifest] = useState<PlatformManifest | null>(null);

  // Trustpilot fields
  const [country, setCountry] = useState('GB');
  const [category, setCategory] = useState('casino');
  const [minRating, setMinRating] = useState(1.0);
  const [maxRating, setMaxRating] = useState(3.5);

  // TripAdvisor fields — mirrors Trustpilot's shape on purpose
  const [taCountry, setTaCountry] = useState('GB');
  const [taCategory, setTaCategory] = useState<'hotels' | 'restaurants' | 'attractions'>('hotels');
  const [taMinRating, setTaMinRating] = useState(1.0);
  const [taMaxRating, setTaMaxRating] = useState(3.0);

  // Yelp fields — country picker reads from platform=yelp taxonomy,
  // category is a free-form slug (plumbers, restaurants, …) from the
  // curated yelp_categories.json seed, plus a Yelp-specific
  // min_review_count filter to drop businesses with too few reviews
  // to be worth cold-outreach.
  const [yCountry, setYCountry] = useState('GB');
  const [yCategory, setYCategory] = useState('plumbers');
  const [yMinRating, setYMinRating] = useState(1.0);
  const [yMaxRating, setYMaxRating] = useState(3.5);
  const [yMinReviewCount, setYMinReviewCount] = useState(5);

  // Facebook fields — two modes (consumers/businesses) toggled by leadType.
  // Consumer mode is now group-first: niche + location → discover groups
  // → in-group search. The legacy single-query open-feed path is the
  // escape hatch (groups_only=false).
  const [fbLeadType, setFbLeadType] = useState<'consumers' | 'businesses'>('consumers');
  const [fbNiche, setFbNiche] = useState('');
  const [fbLocation, setFbLocation] = useState('London');
  // Operator override for the generated search phrase. Blank = use the
  // intent-shaped default from `defaultFbQuery` below; this is a default,
  // not a lock, because phrasing is the biggest lever on cost per lead.
  const [fbQueryOverride, setFbQueryOverride] = useState('');
  const [fbCategory, setFbCategory] = useState('dentist');
  const [fbCountry, setFbCountry] = useState('GB');

  // Shared flags
  const [enrich, setEnrich] = useState(false);
  const [verify, setVerify] = useState(false);
  const [forceRescrape, setForceRescrape] = useState(false);

  // Synchronous click-lock so a burst of clicks can't queue multiple POSTs
  // before the parent's loading state has propagated.
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Async guard for the TripAdvisor cost-confirmation dialog. The advisory
  // component populates this whenever the country changes.
  const guardRef = useRef<(() => Promise<boolean>) | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || loading) return;

    let params: ScrapeParams;
    if (platform === 'tripadvisor') {
      params = {
        platform: 'tripadvisor',
        country: taCountry,
        category: taCategory,
        min_rating: taMinRating,
        max_rating: taMaxRating,
        enrich,
        verify,
        forceRescrape,
      } satisfies TripAdvisorScrapeParams;
    } else if (platform === 'yelp') {
      params = {
        platform: 'yelp',
        country: yCountry,
        category: yCategory,
        min_rating: yMinRating,
        max_rating: yMaxRating,
        min_review_count: yMinReviewCount,
        enrich,
        verify,
        forceRescrape,
      } satisfies YelpScrapeParams;
    } else if (platform === 'facebook') {
      // Consumer mode needs a `query` string for facebook.com/search/posts/?q=
      // The operator-facing form asks for niche + location separately; we
      // synthesize an intent-shaped query from the niche (see defaultFbQuery
      // for the 2026-08-03 measurement: geo-stuffed "looking for a plumber in
      // Manchester" = 0/20 usable, intent "need a plumber recommendation" =
      // real consumer asks). The operator can override the phrase in the form;
      // blank means "use the default".
      const fbQuery =
        fbLeadType === 'consumers'
          ? (fbQueryOverride.trim().replace(/\s+/g, ' ') || defaultFbQuery(fbNiche, fbLocation))
          : undefined;
      params = {
        platform: 'facebook',
        lead_type: fbLeadType,
        ...(fbLeadType === 'consumers'
          ? { niche: fbNiche, location: fbLocation, query: fbQuery }
          : { category: fbCategory, country: fbCountry }),
        enrich,
        verify,
        forceRescrape,
      } satisfies FacebookScrapeParams;
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

    if (platform === 'tripadvisor' && guardRef.current) {
      const ok = await guardRef.current();
      if (!ok) return;
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
              setPlatform(name as SupportedPlatform);
              setActiveManifest(manifest);
            }}
            disabled={busy}
            onManifests={(ms) => {
              const m = ms.find((mm) => mm.name === platform);
              if (m) setActiveManifest(m);
            }}
          />
          {/* The "requires_proxy" manifest flag used to surface a "run from local
              mode only" warning here. The Windows EC2 worker (commits 2026-06-03)
              now runs scrapes for this platform via Brave + residential proxy +
              persistent profile, so the warning is no longer accurate. The
              "Requires at least one connected <platform> account" notice below
              already tells the operator what they actually need to do. */}
        </div>

        {platform === 'trustpilot' && (
          <>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="scrape-country">
                Country
              </label>
              <CountryPicker id="scrape-country" value={country} onChange={setCountry} disabled={busy} restrict={OUTREACH_COUNTRY_CODES} />
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
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="ta-country">
                Country
              </label>
              <CountryPicker id="ta-country" value={taCountry} onChange={setTaCountry} disabled={busy} restrict={OUTREACH_COUNTRY_CODES} />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="ta-category">
                Category
              </label>
              <Combobox
                id="ta-category"
                value={taCategory}
                onChange={(v) => setTaCategory(v as 'hotels' | 'restaurants' | 'attractions')}
                options={LISTING_TYPE_OPTIONS}
                placeholder="Pick a category"
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
            <div className="sm:col-span-2 lg:col-span-3">
              <ScrapeCostAdvisory
                country={taCountry}
                onGuardReady={(g) => { guardRef.current = g; }}
              />
            </div>
          </>
        )}

        {platform === 'facebook' && (
          <>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-on-surface mb-1.5">
                Lead type
              </label>
              <div className="flex gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="fb-lead-type"
                    value="consumers"
                    checked={fbLeadType === 'consumers'}
                    onChange={() => setFbLeadType('consumers')}
                    disabled={busy}
                  />
                  People asking for a service (post authors)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="fb-lead-type"
                    value="businesses"
                    checked={fbLeadType === 'businesses'}
                    onChange={() => setFbLeadType('businesses')}
                    disabled={busy}
                  />
                  Businesses in a niche (page owners)
                </label>
              </div>
            </div>

            {fbLeadType === 'consumers' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="fb-niche">
                    Niche / service
                  </label>
                  <NichePicker
                    id="fb-niche"
                    value={fbNiche}
                    onChange={setFbNiche}
                    disabled={busy}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="fb-location">
                    Location / city
                  </label>
                  <LocationPicker
                    id="fb-location"
                    value={fbLocation}
                    onChange={setFbLocation}
                    disabled={busy}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="fb-query">
                    Search phrase <span className="text-on-surface-variant font-normal">(optional override)</span>
                  </label>
                  <input
                    id="fb-query"
                    type="text"
                    placeholder={defaultFbQuery(fbNiche, fbLocation) || 'need a <niche> recommendation'}
                    value={fbQueryOverride}
                    onChange={(e) => setFbQueryOverride(e.target.value)}
                    disabled={busy}
                    className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                  />
                </div>
                <div className="sm:col-span-2 lg:col-span-3">
                  <ComboWarning niche={fbNiche} location={fbLocation} />
                  <p className="text-[11px] text-on-surface-variant">
                    Searches public FB posts for <strong>&quot;{fbQueryOverride.trim() || defaultFbQuery(fbNiche, fbLocation) || 'need a <niche> recommendation'}&quot;</strong> &mdash;
                    intent phrasing beats geo-stuffing by a wide margin (measured 2026-08-03: &quot;looking for a plumber in
                    Manchester&quot; returned 0 usable asks out of 20, all adverts). Leave the phrase blank to use that
                    default; {fbLocation || 'the location'} still scopes the results. Each post is filtered to keep only
                    real consumer asks (asking-only + Gemini niche+location match). Streams live; cancellable.
                  </p>
                </div>
              </>
            )}
            {fbLeadType === 'businesses' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="fb-country">
                    Country
                  </label>
                  <CountryPicker id="fb-country" value={fbCountry} onChange={setFbCountry} disabled={busy} restrict={OUTREACH_COUNTRY_CODES} />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="fb-category">
                    Page category slug
                  </label>
                  <input
                    id="fb-category"
                    type="text"
                    placeholder="dentist, plumber, restaurant, …"
                    value={fbCategory}
                    onChange={(e) => setFbCategory(e.target.value)}
                    disabled={busy}
                    className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                  />
                </div>
              </>
            )}
            <div className="sm:col-span-2 lg:col-span-3">
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                Requires at least one connected Facebook account. Manage in <a href="/social-accounts" className="underline">Social Accounts</a>.
              </p>
            </div>
          </>
        )}

        {platform === 'yelp' && (
          <>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="yelp-country">
                Country
              </label>
              <CountryPicker
                id="yelp-country"
                value={yCountry}
                onChange={setYCountry}
                disabled={busy}
                platform="yelp"
                restrict={OUTREACH_COUNTRY_CODES}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="yelp-category">
                Category
              </label>
              <CategoryPicker
                id="yelp-category"
                value={yCategory}
                onChange={setYCategory}
                disabled={busy}
                platform="yelp"
              />
            </div>
            <RangeInput
              label="Rating"
              suffix="★"
              value={[yMinRating, yMaxRating]}
              onChange={([lo, hi]) => {
                setYMinRating(lo);
                setYMaxRating(hi);
              }}
              min={1}
              max={5}
              step={0.5}
              disabled={busy}
            />
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="yelp-min-reviews">
                Min review count
              </label>
              <input
                id="yelp-min-reviews"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={yMinReviewCount}
                onChange={(e) => setYMinReviewCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                disabled={busy}
                className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
              />
              <p className="mt-1 text-[11px] text-on-surface-variant">
                Drop businesses with fewer than this many Yelp reviews
              </p>
            </div>
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

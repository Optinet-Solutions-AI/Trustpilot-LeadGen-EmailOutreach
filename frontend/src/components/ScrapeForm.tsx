'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ScrapeParams, TripAdvisorScrapeParams, TrustpilotScrapeParams, YelpScrapeParams, FacebookScrapeParams, InstagramScrapeParams } from '../types/scrape';
import api from '../api/client';
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

// Outreach country scope. Restricts the Trustpilot, TripAdvisor, and Yelp
// country dropdowns to the same set that maps cleanly onto the
// country-mismatch group filter in tools/scraper/platforms/facebook.py.
// Covers full Europe + United States. Keep these ISO codes in sync with
// CITY_TO_COUNTRY + _COUNTRY_NAME_TOKENS in that Python file.
//
// The FB businesses dropdown no longer uses this list directly (Option A:
// it's gated to onboarded active markets via GET /api/social-accounts/countries,
// fetched below) — this constant is kept only as its pre-fetch fallback so the
// picker doesn't render empty for the instant before that call resolves.
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
 * Intent-shaped AND place-anchored. Three runs of 20 real posts each,
 * through the same actor, only the query differing:
 *
 *   query                                        geography            intent-qualified
 *   "looking for a plumber in Manchester"         Manchester           0 / 20
 *   "need a plumber recommendation"               GLOBAL, scattered    7 / 20
 *   "need a plumber recommendation Manchester"     Manchester, all 20  1 / 20
 *
 * "looking for" reads as ad copy; the place name is what makes results
 * local. On in-target leads per pound the place-anchored form wins outright
 * (5% intent x ~100% geography beats 35% intent x ~10% geography) because a
 * lead outside the target town is worth far less than one inside it. A prior
 * change stripped the location back out based on the first row alone — that
 * conflated "looking for" phrasing with the place name. DO NOT remove the
 * location from this query again; keep the intent phrasing AND the place.
 *
 * Mirror of the fallback query builder in server/src/routes/scrape.ts (the
 * server-side fallback used when a submitted job carries no query) — the
 * frontend cannot import server code, so keep the two identical.
 */
export function defaultFbQuery(niche: string, location = ''): string {
  const n = niche.trim().replace(/\s+/g, ' ');
  const loc = location.trim().replace(/\s+/g, ' ');
  if (n && loc) return `need a ${n} recommendation ${loc}`;
  if (n) return `need a ${n} recommendation`;
  // No niche: fall back to the bare location rather than emitting a
  // dangling "need a recommendation", which matches nothing useful.
  return loc;
}

/**
 * Facebook params plus the two operator-named-group fields.
 *
 * They are not on `FacebookScrapeParams` yet (frontend/src/types/scrape.ts);
 * declared here so this form stays type-checked, and so the extra keys travel
 * verbatim in the POST body — ScrapeContext sends the Facebook params object
 * through untouched, and the API merges every non-control body field into the
 * job's `filters`.
 */
export type FacebookGroupScrapeParams = FacebookScrapeParams & {
  /** JSON array, one entry per group. Never a raw pasted string. */
  group_urls?: string[];
  /** Keyword the actor filters on BEFORE billing — the real cost control. */
  group_keyword?: string;
};

/**
 * Split a pasted block of group URLs into the array the API expects.
 *
 * Trims each line, drops blanks and duplicates, and drops obvious junk: an
 * entry has to be a Facebook URL or a bare numeric group id. The Python side
 * normalises bare ids into full URLs (facebook_apify.normalise_group_url), so
 * both shapes are legitimate input — a stray note or half-typed word is not,
 * and every rejected line is one fewer billable actor run on nothing.
 */
export function parseGroupUrls(pasted: string): string[] {
  const seen = new Set<string>();
  return pasted
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /facebook\.com\//i.test(line) || /^\d{5,}$/.test(line))
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
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

type SupportedPlatform = 'trustpilot' | 'tripadvisor' | 'yelp' | 'facebook' | 'instagram';

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
  // Outside the US most Yelp listings have never been reviewed at all —
  // every one of 133 Austrian roofers measured had no rating. Those markets
  // return nothing until this is on.
  const [yIncludeUnrated, setYIncludeUnrated] = useState(false);

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
  // Operator-named groups. Filling these in switches the run from
  // "search Facebook" to "read these groups": Apify group DISCOVERY returns 0
  // items for any query, so the operator supplies the groups and discovery is
  // skipped. Empty = today's search-based flow, untouched.
  const [fbGroupUrls, setFbGroupUrls] = useState('');
  const [fbGroupKeyword, setFbGroupKeyword] = useState('recommend');
  const fbParsedGroups = parseGroupUrls(fbGroupUrls);
  const fbIsGroupScrape = fbParsedGroups.length > 0;

  // Active-market gate (Option A). The FB businesses country field is
  // restricted to countries that actually have an onboarded, active FB
  // account — picking anything else can never run. null = not fetched yet
  // (falls back to OUTREACH_COUNTRY_CODES below so the picker isn't empty
  // for an instant); [] = fetched and genuinely no active markets.
  const [fbActiveCountries, setFbActiveCountries] = useState<string[] | null>(null);

  useEffect(() => {
    if (platform !== 'facebook' || fbActiveCountries !== null) return;
    let cancelled = false;
    api
      .get('/social-accounts/countries')
      .then((res) => {
        if (cancelled) return;
        const list = (res.data?.data?.countries ?? []) as string[];
        setFbActiveCountries(Array.isArray(list) ? list : []);
      })
      .catch(() => { if (!cancelled) setFbActiveCountries([]); });
    return () => { cancelled = true; };
  }, [platform, fbActiveCountries]);

  // Instagram fields — hashtag-driven; IG has no groups. lead_type mirrors
  // FB: businesses (SMBs advertising under the tag — the default pitch target)
  // vs consumers (intent-filtered asks). location is optional: IG tag search is
  // global, so it stamps geo + drops confident wrong-country posts rather than
  // filtering the search. country also pins the residential proxy exit.
  const [igLeadType, setIgLeadType] = useState<'businesses' | 'consumers'>('businesses');
  const [igQuery, setIgQuery] = useState('');
  const [igLocation, setIgLocation] = useState('London');
  const [igCountry, setIgCountry] = useState('GB');

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

    let params: ScrapeParams | FacebookGroupScrapeParams;
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
        include_unrated: yIncludeUnrated,
        enrich,
        verify,
        forceRescrape,
      } satisfies YelpScrapeParams;
    } else if (platform === 'facebook') {
      // Consumer mode needs a `query` string for facebook.com/search/posts/?q=
      // The operator-facing form asks for niche + location separately; we
      // synthesize an intent-shaped, place-anchored query from both (see
      // defaultFbQuery's docstring for the measurement table backing the
      // "need a <niche> recommendation <location>" shape). The operator can
      // override the phrase in the form; blank means "use the default".
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
        // Group fields go out as a real ARRAY (parsed, trimmed, deduped) and
        // only when the operator actually named groups — an empty textarea
        // must not switch the search-based flow into group mode.
        ...(fbLeadType === 'consumers' && fbIsGroupScrape
          ? {
              group_urls: fbParsedGroups,
              group_keyword: fbGroupKeyword.trim() || undefined,
            }
          : {}),
        enrich,
        verify,
        forceRescrape,
      } satisfies FacebookGroupScrapeParams;
    } else if (platform === 'instagram') {
      // Flat shape (like Facebook): posted as-is via ScrapeContext's `else`
      // branch; the server merges these top-level fields into filters. Strip a
      // stray leading '#' so the Python plugin's _normalize_hashtag gets a bare
      // tag. location is optional; blank means "use country for the geo stamp".
      params = {
        platform: 'instagram',
        lead_type: igLeadType,
        query: igQuery.trim().replace(/^#+/, ''),
        location: igLocation.trim() || undefined,
        country: igCountry,
        enrich,
        verify,
        forceRescrape,
      } satisfies InstagramScrapeParams;
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
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="fb-group-urls">
                    Facebook group URLs{' '}
                    <span className="text-on-surface-variant font-normal">(optional &mdash; one per line)</span>
                  </label>
                  <textarea
                    id="fb-group-urls"
                    rows={4}
                    placeholder={'https://www.facebook.com/groups/1572344082987398\nhttps://www.facebook.com/groups/435424147376112'}
                    value={fbGroupUrls}
                    onChange={(e) => setFbGroupUrls(e.target.value)}
                    disabled={busy}
                    className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface font-mono focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                  />
                  <p className="mt-1 text-[11px] text-on-surface-variant">
                    Full URLs or bare group ids. Leave empty to search Facebook instead.
                    {fbGroupUrls.trim() ? (
                      <>
                        {' '}Recognised: <strong>{fbParsedGroups.length}</strong> group
                        {fbParsedGroups.length === 1 ? '' : 's'}.
                      </>
                    ) : null}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="fb-group-keyword">
                    Group keyword filter
                  </label>
                  <input
                    id="fb-group-keyword"
                    type="text"
                    placeholder="recommend"
                    value={fbGroupKeyword}
                    onChange={(e) => setFbGroupKeyword(e.target.value)}
                    disabled={busy}
                    className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                  />
                  <p className="mt-1 text-[11px] text-on-surface-variant">
                    Filters posts <strong>before</strong> they are billed &mdash; the main cost
                    control on a group scrape. One word beats a phrase.
                  </p>
                </div>
                <div className="sm:col-span-2 lg:col-span-3">
                  {fbIsGroupScrape ? (
                    <p className="text-[11px] rounded-lg bg-surface-variant/60 px-3 py-2 text-on-surface-variant">
                      <strong>Group scrape.</strong> Reads the {fbParsedGroups.length} group
                      {fbParsedGroups.length === 1 ? '' : 's'} above directly, keeping posts that
                      match <strong>&quot;{fbGroupKeyword.trim() || 'recommend'}&quot;</strong>.
                      Facebook search and group discovery are skipped, so the search phrase above
                      is not used. <strong>The location is not used to match posts</strong> &mdash;
                      the group already fixes the geography, and requiring the town inside the post
                      text finds nothing, because members never name their own town. It is still
                      used to tag each lead&apos;s country. Every post still goes through the
                      consumer-intent filter.
                    </p>
                  ) : (
                    <>
                      <ComboWarning niche={fbNiche} location={fbLocation} />
                      <p className="text-[11px] text-on-surface-variant">
                        Searches public FB posts for <strong>&quot;{fbQueryOverride.trim() || defaultFbQuery(fbNiche, fbLocation) || 'need a <niche> recommendation <location>'}&quot;</strong> &mdash;
                        intent phrasing keeps results on-topic and the place name keeps them local (measured: dropping
                        either half of that phrase tanks intent or geography). Leave the phrase blank to use that default.
                        Each post is filtered to keep only real consumer asks (asking-only + Gemini intent match). Streams
                        live; cancellable.
                      </p>
                    </>
                  )}
                </div>
              </>
            )}
            {fbLeadType === 'businesses' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="fb-country">
                    Country
                  </label>
                  {fbActiveCountries !== null && fbActiveCountries.length === 0 ? (
                    <p className="text-[11px] text-on-surface-variant">
                      No onboarded Facebook accounts yet &mdash; add one on the{' '}
                      <a href="/social-accounts" className="underline">Social Accounts</a> page.
                    </p>
                  ) : (
                    <CountryPicker
                      id="fb-country"
                      value={fbCountry}
                      onChange={setFbCountry}
                      disabled={busy}
                      restrict={fbActiveCountries ?? OUTREACH_COUNTRY_CODES}
                    />
                  )}
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

        {platform === 'instagram' && (
          <>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-on-surface mb-1.5">
                Lead type
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ig-lead-type"
                    value="businesses"
                    checked={igLeadType === 'businesses'}
                    onChange={() => setIgLeadType('businesses')}
                    disabled={busy}
                  />
                  Businesses advertising under a hashtag (SMBs to pitch)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ig-lead-type"
                    value="consumers"
                    checked={igLeadType === 'consumers'}
                    onChange={() => setIgLeadType('consumers')}
                    disabled={busy}
                  />
                  Consumers asking under a hashtag (intent-filtered)
                </label>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="ig-query">
                Niche hashtag <span className="text-on-surface-variant font-normal">(without #)</span>
              </label>
              <input
                id="ig-query"
                type="text"
                placeholder="plumber, roofer, dentist, …"
                value={igQuery}
                onChange={(e) => setIgQuery(e.target.value)}
                disabled={busy}
                className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="ig-country">
                Country
              </label>
              <CountryPicker
                id="ig-country"
                value={igCountry}
                onChange={setIgCountry}
                disabled={busy}
                restrict={OUTREACH_COUNTRY_CODES}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="ig-location">
                Location / city <span className="text-on-surface-variant font-normal">(optional)</span>
              </label>
              {/* Searchable city dropdown that also accepts a typed-in city
                  (allowCustom): IG hashtag search is global, so any city is
                  valid — pick one for the flag/language hint, or type your own
                  and press Enter. */}
              <LocationPicker
                id="ig-location"
                value={igLocation}
                onChange={setIgLocation}
                disabled={busy}
                allowCustom
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <p className="text-[11px] text-on-surface-variant">
                Scrapes the public <strong>#{igQuery.trim().replace(/^#+/, '') || 'hashtag'}</strong> feed
                {' '}(no login needed for discovery). Instagram tag search is global, so the country and
                optional city don&apos;t narrow the search — they tag each lead and drop posts confidently
                in the wrong country. {igLeadType === 'consumers'
                  ? 'Only real consumer asks survive the Gemini intent filter.'
                  : 'Keeps every posting account under the tag — under a niche hashtag those are the advertising SMBs to pitch.'}
              </p>
              <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                Requires at least one connected Instagram account. Manage in <a href="/social-accounts" className="underline">Social Accounts</a>.
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
            <div className="sm:col-span-2">
              <Toggle
                checked={yIncludeUnrated}
                onChange={(e) => setYIncludeUnrated(e.target.checked)}
                disabled={busy}
                label="Include unrated businesses"
                description="Keeps listings with no rating at all. Needed outside the US, where most businesses have never been reviewed — the rating and review filters don't apply to them."
              />
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

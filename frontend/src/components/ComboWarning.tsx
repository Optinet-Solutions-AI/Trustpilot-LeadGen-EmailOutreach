'use client';

import { findNicheBySlug } from '../data/fb-niches';
import { findCityLanguage } from './LocationPicker';

interface Props {
  niche: string;
  location: string;
}

/**
 * Stateless inline warning beneath the niche/location picker pair.
 * Emits at most ONE message — niche tier check takes precedence
 * because it's the more impactful problem (B2B niches return 0
 * leads regardless of location).
 *
 * Never blocks submit — the form's submit button is independently
 * controlled. This is purely an informational hint to set operator
 * expectations before the scrape runs.
 */
export default function ComboWarning({ niche, location }: Props) {
  const nicheEntry = findNicheBySlug(niche);
  const cityLanguage = findCityLanguage(location);

  // Priority 1: B2B / low-tier niche — outweighs language concerns.
  if (nicheEntry?.tier === 'low') {
    return (
      <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        ⚠️ <strong>B2B niche on FB:</strong> this niche rarely surfaces on
        community groups. Expect few or zero leads. Try a trade/home-service
        niche if you want consistent results.
      </div>
    );
  }

  // Priority 2: known niche + non-English location.
  if (nicheEntry && cityLanguage) {
    return (
      <div className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
        💡 <strong>Language tip:</strong> posts in {location} are usually in {cityLanguage}.
        Consider the native term for "{nicheEntry.label}" (e.g. <em>idraulico</em>{' '}
        for plumber in Italian) to surface more leads.
      </div>
    );
  }

  // No warning when:
  //  - niche is free text not in the curated list (we don't know the tier)
  //  - both niche and location look fine
  return null;
}

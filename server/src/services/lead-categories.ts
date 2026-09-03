/**
 * Canonical lead-category map — TypeScript MIRROR.
 *
 * ⚠️  The source of truth is tools/db/category_canonical.py. Read that file's
 * header for the grouping rules and the canonical-form convention before
 * touching anything here.
 *
 * This mirror exists because the API filters `leads.category` and cannot call
 * Python per request. It is kept honest by lead-categories.test.ts, which
 * parses CANONICAL_FAMILIES straight out of the Python file and fails if the
 * two maps differ by so much as one alias. (The Python suite has the
 * equivalent test pointing the other way.) If you add a family, add it in
 * BOTH files — the tests will tell you off if you don't.
 */

/** canonical -> every label that means the same trade. Mirror of the Python dict. */
export const CANONICAL_FAMILIES: Record<string, readonly string[]> = {
  // ── Trades: canonical is the singular agent noun ──
  plumber: ['plumber', 'plumbers', 'plumbing', 'plumbing_service', 'plumbing_services'],
  electrician: ['electrician', 'electricians', 'electrical', 'electrical_service', 'electrical_services'],
  roofer: ['roofer', 'roofers', 'roofing', 'roofing_service', 'roofing_services'],
  landscaper: ['landscaper', 'landscapers', 'landscaping', 'landscaping_service', 'landscaping_services'],
  handyman: ['handyman', 'handymen', 'handyman_service', 'handyman_services'],
  locksmith: ['locksmith', 'locksmiths'],
  chiropractor: ['chiropractor', 'chiropractors'],
  lawyer: ['lawyer', 'lawyers'],
  contractor: ['contractor', 'contractors'],
  // ── Business kinds: canonical is the singular noun ──
  restaurant: ['restaurant', 'restaurants'],
  hotel: ['hotel', 'hotels'],
  gym: ['gym', 'gyms'],
  clinic: ['clinic', 'clinics'],
  // ── Sector slugs: platform's own form stays canonical ──
  hvac: ['hvac', 'hvac_service', 'hvac_services'],
  autorepair: ['autorepair', 'autorepairs', 'auto_repair', 'auto_repairs', 'auto_repair_shop'],
  car_dealer: ['car_dealer', 'car_dealers', 'car_dealership', 'car_dealerships'],
  game_store: ['game_store', 'game_stores'],
  video_game_store: ['video_game_store', 'video_game_stores'],
  clothing_store: ['clothing_store', 'clothing_stores'],
  event_venue: ['event_venue', 'event_venues'],
  wedding_venue: ['wedding_venue', 'wedding_venues'],
  utilities: ['utilities', 'utility'],
};

/** alias -> canonical, built once. Overlapping aliases throw at import time. */
export const ALIAS_TO_CANONICAL: Record<string, string> = (() => {
  const index: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(CANONICAL_FAMILIES)) {
    if (!aliases.includes(canonical)) {
      throw new Error(`category family '${canonical}' does not list its own canonical form as an alias`);
    }
    for (const alias of aliases) {
      const owner = index[alias];
      if (owner !== undefined && owner !== canonical) {
        throw new Error(`category alias '${alias}' is claimed by both '${owner}' and '${canonical}'`);
      }
      index[alias] = canonical;
    }
  }
  return index;
})();

/**
 * Lowercase snake_case a raw category string. No-op on every value currently
 * in the DB (they are all already slugs); it only bites on operator free-text.
 */
export function slugifyCategory(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || null;
}

/** Known family member -> canonical form. Anything else passes through slugified. */
export function canonicalizeCategory(value: string | null | undefined): string | null {
  const slug = slugifyCategory(value);
  if (slug === null) return null;
  return ALIAS_TO_CANONICAL[slug] ?? slug;
}

/** Every label meaning the same as `value`, canonical first. `[]` for empty input. */
export function categoryFamily(value: string | null | undefined): string[] {
  const canonical = canonicalizeCategory(value);
  if (canonical === null) return [];
  const aliases = CANONICAL_FAMILIES[canonical];
  if (!aliases) return [canonical];
  const rest = aliases.filter((a) => a !== canonical).sort();
  return [canonical, ...rest];
}

/**
 * Minimal substring needles for a case-insensitive LIKE filter. A needle is
 * dropped when another needle is a substring of it (`%plumbing%` already
 * covers `%plumbing_services%`), which keeps the generated PostgREST
 * `or=(...)` short against a 13k-row table.
 */
export function categoryFilterPatterns(value: string | null | undefined): string[] {
  const members = categoryFamily(value);
  if (members.length === 0) return [];
  const unique = [...new Set(members)].sort();
  return unique
    .filter((m) => !unique.some((other) => other !== m && m.includes(other)))
    .sort();
}

/**
 * PostgREST `or=(...)` body that matches a category's WHOLE family, or null
 * when there is nothing to filter on.
 *
 * This is the non-destructive half of the de-fragmentation fix: the operator's
 * 13,251 existing rows keep their original labels and still become findable,
 * because a filter for `plumber` expands to `plumber|plumbing` and therefore
 * matches all 109 plumbing-trade rows instead of the 43 spelled `plumber(s)`.
 *
 * Needles are `[a-z0-9_]` only (slugified), so none of them can inject a comma
 * or paren into the or-expression.
 */
/**
 * ── UI-only selection roll-ups ───────────────────────────────────────────
 *
 * These are NOT normalisation, and deliberately live apart from
 * CANONICAL_FAMILIES. The Python source of truth keeps the gambling cluster
 * fragmented on purpose ("a land-based casino, an online bookmaker, a bingo
 * hall and a gambling instructor are different businesses"), a test enforces
 * that every one of those labels canonicalises to ITSELF, and scraping
 * depends on the platform's own taxonomy staying intact. None of that
 * changes here.
 *
 * What changes is the OPERATOR's side. In the Lead Matrix and the campaign
 * wizard, "Gambling (all)" was a substring match on the literal word
 * "gambling", so it returned ~1,712 leads and silently missed the 2,594
 * casinos, 474 betting agencies and 214 sports-betting rows -- about
 * two-thirds of the book. Selecting each sub-category by hand meant running
 * the same campaign a dozen times.
 *
 * So a group slug expands to every member of the roll-up, while each
 * sub-category stays independently selectable exactly as before. Scraping
 * never resolves a group; only the lead filters do.
 *
 * Membership was decided by the operator on 2026-09-02 against live counts
 * and a sample of real company names:
 *   - `gaming` / `gaming_service_provider` are IN. The category is a genuine
 *     mix (TenoBet live-dealer platform sits beside Gamers247 and a game
 *     server host); the operator chose reach over precision.
 *   - lottery is IN.
 *   - `game_store` / `video_game_store` are OUT -- those are unambiguously
 *     retail (GameStop UK, Ubisoft, The Works), and a casino
 *     reputation-management pitch has no business landing there. They get
 *     their own `video_games` roll-up instead.
 */
export const CATEGORY_GROUPS: Record<string, readonly string[]> = {
  gambling: [
    'casino', 'online_casino_or_bookmaker',
    'gambling', 'gambling_house', 'gambling_service', 'gambling_instructor',
    'betting_agency', 'bookmaker', 'online_sports_betting', 'off_track_betting_shop',
    'bingo_hall',
    'gaming', 'gaming_service_provider',
    'lottery_vendor', 'lottery_retailer', 'lottery_shop', 'online_lottery_ticket_vendor',
  ],
  // Retail, not gambling. Kept as its own roll-up so the two can never be
  // confused again.
  video_games: ['game_store', 'video_game_store'],
};

/** True when `value` names a roll-up rather than a single category. */
export function isCategoryGroup(value: string | null | undefined): boolean {
  const slug = slugifyCategory(value);
  return slug !== null && Object.prototype.hasOwnProperty.call(CATEGORY_GROUPS, slug);
}

/**
 * Every ILIKE needle a group should match, with each member first expanded
 * through its own canonical family (so `casinos` is caught alongside
 * `casino`), then reduced the same way categoryFilterPatterns reduces: a
 * needle that CONTAINS another needle is dropped, because the shorter one's
 * %substring% match already covers it.
 *
 * The reduction only ever runs among the group's own members, so it can never
 * produce a needle broad enough to pull in a label the group excludes -- the
 * `game_store` case this roll-up exists to keep out.
 */
export function categoryGroupPatterns(value: string | null | undefined): string[] {
  const slug = slugifyCategory(value);
  if (slug === null) return [];
  const members = CATEGORY_GROUPS[slug];
  if (!members) return [];
  const expanded = new Set<string>();
  for (const member of members) {
    for (const label of categoryFamily(member)) expanded.add(label);
  }
  const unique = [...expanded].sort();
  return unique
    .filter((m) => !unique.some((other) => other !== m && m.includes(other)))
    .sort();
}

export function categoryOrFilter(value: string | null | undefined): string | null {
  // A roll-up expands to its whole membership; anything else keeps the
  // existing single-family behaviour.
  const needles = isCategoryGroup(value)
    ? categoryGroupPatterns(value)
    : categoryFilterPatterns(value);
  if (needles.length === 0) return null;
  return needles.map((n) => `category.ilike.%${n}%`).join(',');
}

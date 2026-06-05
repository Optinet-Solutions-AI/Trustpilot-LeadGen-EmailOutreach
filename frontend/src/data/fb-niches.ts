/**
 * Curated Facebook-friendly consumer-ask niches for the scrape form's
 * NichePicker. Tier reflects empirical FB-group activity — yesterday's
 * scrape tests showed B2B niches (website builder, accountant) return
 * 0 leads on FB groups, while trade niches (handyman, electrician) work.
 *
 * Operators can still type any niche as free text on the form — this
 * list is suggestions, not a hard allowlist.
 *
 * Adding a niche: drop a {slug, label, tier, group} row. Slugs are the
 * actual lowercase string sent to the scraper.
 *
 * Tier ranking will move to data-driven (from scrape_jobs success
 * history) in a future session — see the design spec dated 2026-06-05.
 */

export type NicheTier = 'high' | 'medium' | 'low';

export interface NicheEntry {
  slug: string;
  label: string;
  tier: NicheTier;
  group: string;
}

export const FB_NICHES: NicheEntry[] = [
  // Trades
  { slug: 'handyman',         label: 'Handyman',         tier: 'high',   group: 'Trades' },
  { slug: 'electrician',      label: 'Electrician',      tier: 'high',   group: 'Trades' },
  { slug: 'carpenter',        label: 'Carpenter',        tier: 'high',   group: 'Trades' },
  { slug: 'painter',          label: 'Painter',          tier: 'high',   group: 'Trades' },
  { slug: 'locksmith',        label: 'Locksmith',        tier: 'high',   group: 'Trades' },
  { slug: 'plumber',          label: 'Plumber',          tier: 'medium', group: 'Trades' },
  { slug: 'mechanic',         label: 'Mechanic',         tier: 'medium', group: 'Trades' },

  // Home & domestic services
  { slug: 'cleaner',          label: 'Cleaner',          tier: 'high',   group: 'Home Services' },
  { slug: 'gardener',         label: 'Gardener',         tier: 'high',   group: 'Home Services' },
  { slug: 'mover',            label: 'Mover',            tier: 'high',   group: 'Home Services' },
  { slug: 'pet sitter',       label: 'Pet Sitter',       tier: 'high',   group: 'Home Services' },
  { slug: 'dog walker',       label: 'Dog Walker',       tier: 'high',   group: 'Home Services' },
  { slug: 'babysitter',       label: 'Babysitter',       tier: 'high',   group: 'Home Services' },
  { slug: 'tutor',            label: 'Tutor',            tier: 'high',   group: 'Home Services' },

  // Personal care & lifestyle
  { slug: 'hairdresser',      label: 'Hairdresser',      tier: 'medium', group: 'Personal Care' },
  { slug: 'beautician',       label: 'Beautician',       tier: 'medium', group: 'Personal Care' },
  { slug: 'personal trainer', label: 'Personal Trainer', tier: 'medium', group: 'Personal Care' },
  { slug: 'photographer',     label: 'Photographer',     tier: 'medium', group: 'Personal Care' },
  { slug: 'dentist',          label: 'Dentist',          tier: 'medium', group: 'Personal Care' },

  // B2B / professional services — low FB-group consumer-ask volume
  { slug: 'website builder',   label: 'Website Builder',   tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'accountant',        label: 'Accountant',        tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'lawyer',            label: 'Lawyer',            tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'consultant',        label: 'Consultant',        tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'marketing agency',  label: 'Marketing Agency',  tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'seo',               label: 'SEO',               tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'copywriter',        label: 'Copywriter',        tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'financial advisor', label: 'Financial Advisor', tier: 'low', group: 'B2B (low FB volume)' },
];

/**
 * Resolve a niche entry by its slug (case-insensitive). Returns undefined
 * when the operator typed a free-text niche not in the curated list — the
 * caller should treat that as "no tier info, no warning".
 */
export function findNicheBySlug(slug: string): NicheEntry | undefined {
  const lower = slug.trim().toLowerCase();
  return FB_NICHES.find((n) => n.slug === lower);
}

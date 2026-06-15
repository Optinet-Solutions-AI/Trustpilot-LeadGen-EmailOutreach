// Pulls business name + aggregate rating from a Trustpilot profile page's
// JSON-LD. Trustpilot embeds an Organization/LocalBusiness node carrying
// `name` and an `aggregateRating` (`ratingValue` + `reviewCount`). Shapes vary
// (bare object, @graph array, top-level array), so walk recursively for the
// first node that actually has an aggregateRating. Dependency-free.

export interface AffiliateMeta {
  name?: string;
  rating?: number;
  reviews?: number;
}

const LD_BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export function extractAffiliateMeta(html: string): AffiliateMeta {
  if (!html) return {};
  for (const m of html.matchAll(LD_BLOCK)) {
    let parsed: unknown;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const found = walkForRating(parsed);
    if (found) return found;
  }
  return {};
}

function walkForRating(node: unknown): AffiliateMeta | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = walkForRating(item);
      if (r) return r;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;

  const obj = node as Record<string, unknown>;
  const agg = obj.aggregateRating;
  if (agg && typeof agg === 'object') {
    const a = agg as Record<string, unknown>;
    const meta: AffiliateMeta = {};
    if (typeof obj.name === 'string' && obj.name.trim()) meta.name = obj.name.trim();
    const rating = toNum(a.ratingValue);
    if (rating != null) meta.rating = rating;
    const reviews = toInt(a.reviewCount);
    if (reviews != null) meta.reviews = reviews;
    if (meta.name || meta.rating != null || meta.reviews != null) return meta;
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = walkForRating(v);
      if (r) return r;
    }
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toInt(v: unknown): number | null {
  const n = toNum(v);
  return n == null ? null : Math.round(n);
}

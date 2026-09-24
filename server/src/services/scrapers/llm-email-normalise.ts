/**
 * The gate every model-discovered email passes before it touches `leads`.
 *
 * A language model finds contact addresses well but types them like prose.
 * Measured 2026-09-24 over 10 TripAdvisor leads our own enrichment had failed
 * on: it found 8, an 80% yield on a tail that had yielded nothing, at $0.046
 * a lead. One of the eight came back as `comenzi@restaurant‑oscar.ro` — a
 * Unicode non-breaking hyphen (U+2011) rather than an ASCII one. It is
 * visually identical, it is not deliverable, and it would have been sent.
 * Another returned two addresses in one string.
 *
 * So: repair what is unambiguously typography, split what is a list, and
 * reject everything else. Rejecting is the right default — a missing address
 * costs one lead, a bounced one costs sending reputation, and the domains are
 * mid-warm-up. Whatever survives here still goes through ZeroBounce before a
 * campaign can use it.
 */

/** Dashes a model substitutes for an ASCII hyphen, all visually identical. */
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;

/** Strict ASCII address. Deliberately narrower than the RFC allows. */
const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/**
 * Invented rather than observed. They look deliverable, and a model reaches
 * for them when it found nothing — which is exactly when we must not write one.
 */
const PLACEHOLDERS = new Set([
  'example@example.com', 'info@example.com', 'email@example.com', 'test@example.com',
  'your@email.com', 'youremail@example.com', 'name@domain.com', 'email@address.com',
  'user@domain.com', 'contact@example.com', 'someone@example.com',
]);

export function normaliseDiscoveredEmails(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string') return [];

  const out: string[] = [];
  const seen = new Set<string>();

  // Split on the separators a model uses for a list, and on the whitespace and
  // punctuation it wraps prose in.
  for (const piece of raw.split(/[\s,;<>()[\]"']+/)) {
    const candidate = piece
      .replace(DASHES, '-')
      .replace(/[.,;:]+$/, '')   // trailing sentence punctuation
      .trim()
      .toLowerCase();

    if (!candidate || !candidate.includes('@')) continue;
    // Any character outside the ASCII set is a homograph or an artefact, not a
    // typo we can safely repair — repairing it would be guessing at the domain.
    if (!ADDRESS.test(candidate)) continue;
    if (PLACEHOLDERS.has(candidate)) continue;
    if (seen.has(candidate)) continue;

    seen.add(candidate);
    out.push(candidate);
  }

  return out;
}

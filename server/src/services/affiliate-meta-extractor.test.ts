import { describe, it, expect } from 'vitest';
import { extractAffiliateMeta } from './affiliate-meta-extractor';

const PAGE = `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"ignore me"},
  {"@type":["Organization","LocalBusiness"],"name":"Casino Ohne OASIS",
   "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.3","reviewCount":"114","bestRating":5}}
]}
</script>
</head><body>live profile</body></html>`;

describe('extractAffiliateMeta', () => {
  it('pulls name, rating (number), reviews (int) from aggregateRating JSON-LD', () => {
    expect(extractAffiliateMeta(PAGE)).toEqual({ name: 'Casino Ohne OASIS', rating: 4.3, reviews: 114 });
  });

  it('returns {} when there is no JSON-LD or no aggregateRating', () => {
    expect(extractAffiliateMeta('<html><body>nothing here</body></html>')).toEqual({});
    expect(extractAffiliateMeta('<script type="application/ld+json">{"@type":"WebPage"}</script>')).toEqual({});
  });

  it('does not throw on malformed JSON-LD', () => {
    expect(extractAffiliateMeta('<script type="application/ld+json">{ not json }</script>')).toEqual({});
  });

  it('handles a bare Organization object (no @graph)', () => {
    const html = `<script type="application/ld+json">
      {"@type":"LocalBusiness","name":"Example Co",
       "aggregateRating":{"ratingValue":3.9,"reviewCount":50}}
    </script>`;
    expect(extractAffiliateMeta(html)).toEqual({ name: 'Example Co', rating: 3.9, reviews: 50 });
  });

  it('handles a top-level JSON-LD array', () => {
    const html = `<script type="application/ld+json">
      [{"@type":"WebPage"},
       {"@type":"LocalBusiness","name":"Array Co",
        "aggregateRating":{"ratingValue":"4.1","reviewCount":"22"}}]
    </script>`;
    expect(extractAffiliateMeta(html)).toEqual({ name: 'Array Co', rating: 4.1, reviews: 22 });
  });

  it('returns a partial result when name is absent', () => {
    const html = `<script type="application/ld+json">
      {"@type":"LocalBusiness","aggregateRating":{"ratingValue":4.0,"reviewCount":7}}
    </script>`;
    expect(extractAffiliateMeta(html)).toEqual({ rating: 4.0, reviews: 7 });
  });
});

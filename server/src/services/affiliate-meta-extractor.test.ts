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
});

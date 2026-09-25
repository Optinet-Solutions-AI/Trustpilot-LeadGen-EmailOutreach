import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An empty ScrapingBee pool may only stop a scrape that USES ScrapingBee.
 *
 * This gate has blocked the wrong runs four times:
 *
 *   1. It applied to every TripAdvisor job, including the `openai` source that
 *      was built specifically to avoid needing ScrapingBee. Every scrape died
 *      with "out of credits (101,595 of 1,000 used)".
 *   2. Fixing the submit route left the runner's own copy, which killed the
 *      job three seconds in instead.
 *   3. A third gate in TripAdvisor's enrichment required the key outright.
 *   4. The fix was written as `!== 'openai'` — exempting exactly ONE source —
 *      so switching to `apify` re-blocked everything all over again.
 *
 * The cause each time was a denylist: naming the sources that are exempt.
 * There is only one source that ScrapingBee credits can legitimately stop, so
 * the test requires the gates to name THAT one instead.
 */

const FILES = [
  ['routes/scrape.ts', join(import.meta.dirname, '..', 'routes', 'scrape.ts')],
  ['services/scrape-runner.ts', join(import.meta.dirname, 'scrape-runner.ts')],
] as const;

describe('the ScrapingBee credit gate', () => {
  test.each(FILES)('%s decides on the scrapingbee source, not on a list of exemptions', (_label, path) => {
    const src = readFileSync(path, 'utf8');
    // Only look at lines that actually branch on the listing source.
    const branches = src
      .split('\n')
      .filter((l) => l.includes('taSource') && (l.includes('===') || l.includes('!==')));

    expect(branches.length, 'expected the credit gate to branch on taSource').toBeGreaterThan(0);

    for (const line of branches) {
      expect(line, [
        'This gate names a source to EXEMPT, which breaks every time a new',
        'cookieless source is added — it has done so four times. Branch on',
        "'scrapingbee' instead, so a source that does not use ScrapingBee is",
        'never stopped by an empty ScrapingBee pool.',
      ].join(' ')).toContain("'scrapingbee'");
      expect(line, 'do not name individual exempt sources here').not.toContain("'openai'");
      expect(line, 'do not name individual exempt sources here').not.toContain("'apify'");
    }
  });
});

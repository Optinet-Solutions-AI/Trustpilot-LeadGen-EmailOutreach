import { describe, test, expect } from 'vitest';
import {
  CATEGORY_GROUPS,
  categoryGroupPatterns,
  categoryOrFilter,
  isCategoryGroup,
} from './lead-categories.js';

/**
 * Guards the operator-facing roll-ups.
 *
 * The one that matters is "NEVER matches video-game retail". The gambling
 * roll-up deliberately includes `gaming`, which is a mixed category, and the
 * needles are ILIKE substrings -- so a careless member list or a bad
 * reduction could produce a needle broad enough to swallow `game_store` and
 * put a casino reputation pitch in front of GameStop and Ubisoft.
 */

/** Does the group's needle set match this stored label? Mirrors the ILIKE. */
const matches = (group: string, label: string): boolean =>
  categoryGroupPatterns(group).some((needle) => label.includes(needle));

describe('category roll-ups', () => {
  test('group slugs are recognised, single categories are not', () => {
    expect(isCategoryGroup('gambling')).toBe(true);
    expect(isCategoryGroup('video_games')).toBe(true);
    expect(isCategoryGroup('casino')).toBe(false);
    expect(isCategoryGroup('plumber')).toBe(false);
    expect(isCategoryGroup('')).toBe(false);
    expect(isCategoryGroup(null)).toBe(false);
  });

  test('every declared member of a group is actually matched by it', () => {
    for (const [group, members] of Object.entries(CATEGORY_GROUPS)) {
      for (const member of members) {
        expect(matches(group, member), `${group} must match its member ${member}`).toBe(true);
      }
    }
  });

  test('gambling covers the labels that carry the book', () => {
    // Live counts on 2026-09-02: casino 2,594 · gambling* 1,712 ·
    // gaming 1,259 · betting_agency 474 · online_sports_betting 214.
    // The old substring filter matched only the gambling* slice.
    for (const label of [
      'casino', 'casinos', 'online_casino_or_bookmaker',
      'gambling', 'gambling_house', 'gambling_service', 'gambling_instructor',
      'betting_agency', 'bookmaker', 'online_sports_betting',
      'off_track_betting_shop', 'bingo_hall',
      'gaming', 'gaming_service_provider',
      'lottery_vendor', 'lottery_retailer', 'lottery_shop', 'online_lottery_ticket_vendor',
    ]) {
      expect(matches('gambling', label), `gambling must match ${label}`).toBe(true);
    }
  });

  test('gambling NEVER matches video-game retail', () => {
    for (const label of ['game_store', 'game_stores', 'video_game_store', 'video_game_stores']) {
      expect(matches('gambling', label), `gambling must NOT match ${label}`).toBe(false);
    }
  });

  test('gambling does not leak into unrelated trades', () => {
    for (const label of ['plumber', 'restaurant', 'bank', 'insurance_agency', 'hotel']) {
      expect(matches('gambling', label), `gambling must NOT match ${label}`).toBe(false);
    }
  });

  test('video_games is retail only', () => {
    expect(matches('video_games', 'game_store')).toBe(true);
    expect(matches('video_games', 'video_game_store')).toBe(true);
    for (const label of ['casino', 'gaming', 'bingo_hall', 'betting_agency']) {
      expect(matches('video_games', label), `video_games must NOT match ${label}`).toBe(false);
    }
  });

  test('a single sub-category still filters on itself alone', () => {
    // Selecting one category must not silently widen to the whole roll-up --
    // "keep the categories selectable separately" is half the requirement.
    expect(categoryOrFilter('casino')).toBe('category.ilike.%casino%');
    expect(categoryOrFilter('bingo_hall')).toBe('category.ilike.%bingo_hall%');
  });

  test('the group filter is a well-formed PostgREST or-expression', () => {
    const filter = categoryOrFilter('gambling');
    expect(filter).not.toBeNull();
    for (const clause of filter!.split(',')) {
      // Slugified needles only -- nothing that could inject a paren or comma.
      expect(clause).toMatch(/^category\.ilike\.%[a-z0-9_]+%$/);
    }
  });
});

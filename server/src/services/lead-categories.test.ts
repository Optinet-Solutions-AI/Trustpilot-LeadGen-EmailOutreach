import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ALIAS_TO_CANONICAL,
  CANONICAL_FAMILIES,
  canonicalizeCategory,
  categoryFamily,
  categoryFilterPatterns,
  categoryOrFilter,
  slugifyCategory,
} from './lead-categories.js';

/**
 * Every distinct `leads.category` value in the live table, surveyed across all
 * 13,251 rows on 2026-08-04. Nothing here may be rewritten unless it is a
 * declared family alias.
 */
const LIVE_INVENTORY = [
  'casino', 'money_insurance', 'gaming', 'investment_service', 'gambling',
  'event_management_company', 'betting_agency', 'car_dealer', 'dental_services',
  'utilities', 'video_game_store', 'online_casino_or_bookmaker', 'game_store',
  'online_sports_betting', 'bars_cafes', 'clinics', 'restaurants_bars',
  'gambling_service', 'hvac', 'repair_services', 'electronics_technology',
  'hotels', 'handyman', 'shopping_fashion', 'autorepair', 'gyms', 'event_venue',
  'gambling_house', 'electrician', 'electricians', 'events_entertainment',
  'plumbing', 'wellness_spa', 'contractors', 'amusement_center', 'bingo_hall',
  'salons_clinics', 'roofing', 'plumbers', 'clothing_store', 'lottery_vendor',
  'restaurants', 'wedding_venue', 'theater_opera', 'chiropractors', 'lawyers',
  'landscaping', 'bookmaker', 'locksmiths', 'online_lottery_ticket_vendor',
  'travel_vacation', 'shipping_logistics', 'animals_pets', 'gambling_instructor',
  'gaming_service_provider', 'plumber', 'lottery_retailer',
  'contractors_consultants', 'lottery_shop',
];

/** Deliberately left fragmented — merging these needs a business decision. */
const UNSAFE_VALUES = [
  'casino', 'gambling', 'gambling_service', 'gambling_house',
  'online_casino_or_bookmaker', 'betting_agency', 'bingo_hall',
  'online_sports_betting', 'bookmaker', 'gaming', 'gaming_service_provider',
  'gambling_instructor', 'lottery_vendor', 'lottery_retailer', 'lottery_shop',
  'online_lottery_ticket_vendor', 'bars_cafes', 'restaurants_bars',
  'dental_services', 'salons_clinics', 'wellness_spa', 'repair_services',
  'contractors_consultants', 'electronics_technology', 'shopping_fashion',
];

describe('canonicalizeCategory', () => {
  test.each([
    ['plumber', 'plumber'],
    ['plumbers', 'plumber'],
    ['plumbing', 'plumber'],
    ['plumbing_services', 'plumber'],
    ['electrician', 'electrician'],
    ['electricians', 'electrician'],
    ['electrical', 'electrician'],
    ['roofing', 'roofer'],
    ['landscaping', 'landscaper'],
    ['locksmiths', 'locksmith'],
    ['chiropractors', 'chiropractor'],
    ['lawyers', 'lawyer'],
    ['contractors', 'contractor'],
    ['restaurants', 'restaurant'],
    ['hotels', 'hotel'],
    ['gyms', 'gym'],
    ['clinics', 'clinic'],
    ['hvac_services', 'hvac'],
    ['auto_repair', 'autorepair'],
    ['car_dealership', 'car_dealer'],
    ['game_stores', 'game_store'],
    ['video_game_stores', 'video_game_store'],
    ['clothing_stores', 'clothing_store'],
    ['event_venues', 'event_venue'],
    ['wedding_venues', 'wedding_venue'],
    ['utility', 'utilities'],
  ])('canonicalises %s -> %s', (raw, expected) => {
    expect(canonicalizeCategory(raw)).toBe(expected);
  });

  test('every declared alias resolves to its canonical', () => {
    for (const [canonical, aliases] of Object.entries(CANONICAL_FAMILIES)) {
      for (const alias of aliases) {
        expect(canonicalizeCategory(alias), `alias ${alias}`).toBe(canonical);
      }
    }
  });

  test('unsafe values pass through unchanged', () => {
    for (const value of UNSAFE_VALUES) {
      expect(canonicalizeCategory(value), `unsafe ${value}`).toBe(value);
    }
  });

  test('no live value is rewritten without a declared family', () => {
    for (const value of LIVE_INVENTORY) {
      const canonical = canonicalizeCategory(value);
      if (canonical !== value) {
        expect(ALIAS_TO_CANONICAL[value], `${value} -> ${canonical}`).toBe(canonical);
      }
    }
  });

  test('unknown values pass through', () => {
    expect(canonicalizeCategory('pet_grooming')).toBe('pet_grooming');
    expect(canonicalizeCategory('zzz_not_a_real_category')).toBe('zzz_not_a_real_category');
  });

  test('messy operator input is normalised', () => {
    expect(canonicalizeCategory('  Plumber ')).toBe('plumber');
    expect(canonicalizeCategory('PLUMBING')).toBe('plumber');
    expect(canonicalizeCategory('Auto Repair')).toBe('autorepair');
    expect(canonicalizeCategory('auto-repair')).toBe('autorepair');
  });

  test.each([null, undefined, '', '   ', '---'])('empty-ish input %s -> null', (raw) => {
    expect(canonicalizeCategory(raw)).toBeNull();
    expect(categoryFamily(raw)).toEqual([]);
    expect(categoryFilterPatterns(raw)).toEqual([]);
    expect(categoryOrFilter(raw)).toBeNull();
  });

  test('slugify is a no-op on the entire live inventory', () => {
    for (const value of LIVE_INVENTORY) {
      expect(slugifyCategory(value), value).toBe(value);
    }
  });
});

describe('categoryFamily', () => {
  test('is symmetric — canonicalising any member yields the canonical, and the family holds every member', () => {
    for (const [canonical, aliases] of Object.entries(CANONICAL_FAMILIES)) {
      const family = categoryFamily(canonical);
      expect(family[0]).toBe(canonical);
      expect([...family].sort()).toEqual([...aliases].sort());
      for (const alias of aliases) {
        expect(canonicalizeCategory(alias)).toBe(canonical);
        expect(categoryFamily(alias), `family(${alias})`).toEqual(family);
      }
    }
  });

  test('an unknown or unsafe value is its own one-member family', () => {
    expect(categoryFamily('pet_grooming')).toEqual(['pet_grooming']);
    expect(categoryFamily('casino')).toEqual(['casino']);
  });
});

describe('categoryFilterPatterns / categoryOrFilter', () => {
  test('drops needles that another needle already covers', () => {
    expect(categoryFilterPatterns('plumbers')).toEqual(['plumber', 'plumbing']);
    expect(categoryFilterPatterns('electricians')).toEqual(['electrical', 'electrician']);
    expect(categoryFilterPatterns('hvac')).toEqual(['hvac']);
  });

  test('every family member is matched by at least one needle', () => {
    for (const [canonical, aliases] of Object.entries(CANONICAL_FAMILIES)) {
      const needles = categoryFilterPatterns(canonical);
      for (const alias of aliases) {
        expect(needles.some((n) => alias.includes(n)), `${canonical}: ${alias}`).toBe(true);
      }
    }
  });

  test('expands a filter to the whole family as a PostgREST or-expression', () => {
    expect(categoryOrFilter('plumber')).toBe('category.ilike.%plumber%,category.ilike.%plumbing%');
    expect(categoryOrFilter('electrician')).toBe('category.ilike.%electrical%,category.ilike.%electrician%');
  });

  test('an unsafe value filters on itself only — no family expansion', () => {
    expect(categoryOrFilter('casino')).toBe('category.ilike.%casino%');
    expect(categoryOrFilter('dental_services')).toBe('category.ilike.%dental_services%');
  });

  test('partial typing still works', () => {
    expect(categoryOrFilter('plumb')).toBe('category.ilike.%plumb%');
    expect(categoryOrFilter('dentis')).toBe('category.ilike.%dentis%');
  });

  test('needles cannot inject into the or-expression', () => {
    // A comma or paren would break out of or=(...). Slugification removes them.
    expect(categoryOrFilter('bar, cafe (downtown)')).toBe('category.ilike.%bar_cafe_downtown%');
    for (const value of [...LIVE_INVENTORY, "o'brien, plumbing)"]) {
      for (const needle of categoryFilterPatterns(value)) {
        expect(needle, needle).toMatch(/^[a-z0-9_]+$/);
      }
    }
  });
});

describe('drift guard vs tools/db/category_canonical.py', () => {
  /** Walk up from cwd until the Python source of truth is found. */
  function findPythonSource(): string {
    let dir = process.cwd();
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(dir, 'tools', 'db', 'category_canonical.py');
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
    throw new Error('could not locate tools/db/category_canonical.py from ' + process.cwd());
  }

  /**
   * Deliberately dumb line-based parse of the Python CANONICAL_FAMILIES dict:
   * it only understands the one-family-per-line format both files are written
   * in, so a reformat that breaks the parse fails the test rather than
   * silently passing an empty comparison.
   */
  function parsePythonFamilies(source: string): Record<string, string[]> {
    const lines = source.split(/\r?\n/);
    const start = lines.findIndex((l) => l.includes('CANONICAL_FAMILIES') && l.includes('='));
    expect(start, 'CANONICAL_FAMILIES not found in the Python source').toBeGreaterThan(-1);
    const families: Record<string, string[]> = {};
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith('}')) break;
      const match = /^\s*"([a-z0-9_]+)":\s*\(([^)]*)\),?\s*$/.exec(line);
      if (match) {
        families[match[1]] = [...match[2].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
      }
    }
    return families;
  }

  test('the two maps are identical', () => {
    const pythonFamilies = parsePythonFamilies(fs.readFileSync(findPythonSource(), 'utf-8'));

    expect(
      Object.keys(pythonFamilies).length,
      'parsed no families out of the Python source — check its format',
    ).toBeGreaterThan(0);

    // Canonical key sets must match exactly...
    expect(Object.keys(pythonFamilies).sort()).toEqual(Object.keys(CANONICAL_FAMILIES).sort());
    // ...and so must every alias list, so a one-word divergence is caught too.
    for (const [canonical, aliases] of Object.entries(pythonFamilies)) {
      expect(CANONICAL_FAMILIES[canonical], `family ${canonical}`).toEqual(aliases);
    }
  });
});

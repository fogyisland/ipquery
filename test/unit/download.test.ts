// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { candidateMonths, DEFAULT_SPECS } from '../../src/etl/download';

describe('candidateMonths', () => {
  it('returns the current month first, then walks back', () => {
    const months = candidateMonths(new Date(Date.UTC(2026, 7, 15)), 4); // Aug 2026
    expect(months).toEqual(['2026-08', '2026-07', '2026-06', '2026-05']);
  });

  it('crosses a year boundary backwards', () => {
    const months = candidateMonths(new Date(Date.UTC(2026, 0, 10)), 4); // Jan 2026
    expect(months).toEqual(['2026-01', '2025-12', '2025-11', '2025-10']);
  });

  it('crosses a year boundary forwards (negative modulo)', () => {
    // Defensive: if someone passes a Date whose UTC month has been
    // mutated weirdly, candidateMonths should still produce a sane list.
    // We test the modulo math directly: month 0..-3 should wrap to
    // 12..10 of the previous year.
    const months = candidateMonths(new Date(Date.UTC(2026, 0, 1)), 4);
    // Dec = month 11 → 2025-12; Nov = 10 → 2025-11; Oct = 9 → 2025-10
    expect(months[0]).toBe('2026-01');
    expect(months[1]).toBe('2025-12');
    expect(months[2]).toBe('2025-11');
    expect(months[3]).toBe('2025-10');
  });

  it('pads single-digit months with a leading zero', () => {
    const months = candidateMonths(new Date(Date.UTC(2026, 8, 1)), 2); // Sep 2026
    expect(months).toEqual(['2026-09', '2026-08']);
  });

  it('respects the lookback limit', () => {
    expect(candidateMonths(new Date(Date.UTC(2026, 7, 1)), 1)).toHaveLength(1);
    expect(candidateMonths(new Date(Date.UTC(2026, 7, 1)), 12)).toHaveLength(12);
  });
});

describe('DEFAULT_SPECS', () => {
  it('covers city, country, and asn with the canonical pipeline filenames', () => {
    const byDest = new Map(DEFAULT_SPECS.map((s) => [s.destName, s]));
    expect(byDest.get('dbip.csv.gz')?.kind).toBe('city');
    expect(byDest.get('dbip-country.csv.gz')?.kind).toBe('country');
    expect(byDest.get('dbip-asn.csv.gz')?.kind).toBe('asn');
  });

  it('uses the DB-IP download URL stem', () => {
    // If DB-IP renames their URL scheme, we want this to be the only
    // place we have to change it. The test pins the current contract.
    expect(DEFAULT_SPECS.map((s) => s.urlStem)).toEqual([
      'dbip-city-lite',
      'dbip-country-lite',
      'dbip-asn-lite',
    ]);
  });
});
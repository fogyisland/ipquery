import { describe, it, expect } from 'vitest';
import { mergeByPriority } from '../../src/etl/merger';
import { parseIp } from '../../src/ip';
import type { NormalizedRecord, Source } from '../../src/types';

function mk(start: string, end: string, source: Source, fields: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return { startIp: parseIp(start)!, endIp: parseIp(end)!, source, ...fields };
}

describe('merger', () => {
  it('uses highest priority source when ranges overlap', () => {
    const merged = mergeByPriority(new Map([
      ['maxmind', [mk('8.8.8.0', '8.8.8.255', 'maxmind', { countryCode: 'US', city: 'MV' })]],
      ['dbip',    [mk('8.8.8.0', '8.8.8.255', 'dbip',    { countryCode: 'GB', city: 'London' })]],
    ]), ['maxmind', 'dbip']);
    expect(merged[0]?.countryCode).toBe('US');
    expect(merged[0]?.countrySource).toBe('maxmind');
  });

  it('falls back to lower priority when higher priority lacks field', () => {
    const merged = mergeByPriority(new Map([
      ['maxmind', [mk('8.8.8.0', '8.8.8.255', 'maxmind', { countryCode: 'US' })]],
      ['dbip',    [mk('8.8.8.0', '8.8.8.255', 'dbip',    { countryCode: 'GB', city: 'London' })]],
    ]), ['maxmind', 'dbip']);
    expect(merged[0]?.countryCode).toBe('US');
    expect(merged[0]?.city).toBe('London');
    expect(merged[0]?.citySource).toBe('dbip');
  });

  it('handles disjoint ranges from different sources', () => {
    const merged = mergeByPriority(new Map([
      ['maxmind', [mk('8.8.8.0', '8.8.8.255', 'maxmind', { countryCode: 'US' })]],
      ['dbip',    [mk('9.9.9.0', '9.9.9.255', 'dbip',    { countryCode: 'GB' })]],
    ]), ['maxmind', 'dbip']);
    expect(merged).toHaveLength(2);
  });

  it('emits records sorted by start_ip', () => {
    const merged = mergeByPriority(new Map([
      ['maxmind', [mk('8.8.8.0', '8.8.8.255', 'maxmind', { countryCode: 'US' })]],
      ['dbip',    [mk('9.9.9.0', '9.9.9.255', 'dbip',    { countryCode: 'GB' })]],
    ]), ['dbip', 'maxmind']); // reversed priority
    expect(merged[0]?.startIp.compare(merged[1]!.startIp)).toBeLessThan(0);
  });

  it('skips segments where no source has data', () => {
    const merged = mergeByPriority(new Map([
      ['maxmind', [mk('8.8.8.0', '8.8.8.10', 'maxmind', { countryCode: 'US' })]],
    ]), ['maxmind']);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.countryCode).toBe('US');
  });
});
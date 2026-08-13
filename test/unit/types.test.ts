import { describe, it, expect } from 'vitest';
import type { Source, NormalizedRecord, LookupResult, EtlRun } from '../../src/types';

describe('types', () => {
  it('Source is a union of three string literals', () => {
    const sources: Source[] = ['maxmind', 'ip2region', 'dbip'];
    expect(sources).toHaveLength(3);
  });

  it('NormalizedRecord has 16-byte Buffer start/end', () => {
    const r: NormalizedRecord = {
      startIp: Buffer.alloc(16),
      endIp: Buffer.alloc(16),
      source: 'maxmind',
    };
    expect(r.startIp).toHaveLength(16);
    expect(r.endIp).toHaveLength(16);
  });

  it('LookupResult requires ip and etag', () => {
    const r: LookupResult = {
      ip: '8.8.8.8',
      country: { source: 'maxmind' },
      etag: '2026-08-12T02:00:00Z',
    };
    expect(r.ip).toBe('8.8.8.8');
  });

  it('EtlRun has required status enum', () => {
    const r: EtlRun = {
      startedAt: new Date(),
      status: 'running',
    };
    expect(['running', 'success', 'failed']).toContain(r.status);
  });
});

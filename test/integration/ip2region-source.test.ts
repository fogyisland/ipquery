import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseIp2regionXdb } from '../../src/etl/sources/ip2region';

describe('ip2region source', () => {
  it('parses fixture into NormalizedRecords', async () => {
    const records = await parseIp2regionXdb(path.join(__dirname, '..', '..', 'fixtures', 'ip2region-sample.xdb'));
    expect(records).toHaveLength(2);
    expect(records[0]?.countryCode).toBe('US');
    expect(records[0]?.isp).toBe('Google');
    expect(records[1]?.countryCode).toBe('CN');
    expect(records[1]?.city).toBe('南京');
  });

  it('marks source = ip2region', async () => {
    const records = await parseIp2regionXdb(path.join(__dirname, '..', '..', 'fixtures', 'ip2region-sample.xdb'));
    for (const r of records) expect(r.source).toBe('ip2region');
  });

  it('country name "中国" maps to CN, "美国" to US', async () => {
    const records = await parseIp2regionXdb(path.join(__dirname, '..', '..', 'fixtures', 'ip2region-sample.xdb'));
    expect(records.find((r) => r.countryCode === 'CN')?.countryName).toBe('中国');
  });
});

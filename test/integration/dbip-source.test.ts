import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseDbipCsv } from '../../src/etl/sources/dbip';

describe('dbip source', () => {
  it('parses fixture CSV.gz into NormalizedRecords', async () => {
    const records = await parseDbipCsv(path.join(__dirname, '..', '..', 'fixtures', 'dbip-sample.csv.gz'));
    expect(records).toHaveLength(3);
    expect(records[0]?.source).toBe('dbip');
    expect(records[0]?.countryCode).toBe('US');
    expect(records[0]?.city).toBe('Mountain View');
    expect(records[2]?.startIp.length).toBe(16); // IPv6 stored in 16-byte buffer
  });

  it('attaches source = dbip to every record', async () => {
    const records = await parseDbipCsv(path.join(__dirname, '..', '..', 'fixtures', 'dbip-sample.csv.gz'));
    for (const r of records) expect(r.source).toBe('dbip');
  });
});
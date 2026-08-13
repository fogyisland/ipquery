// SPDX-License-Identifier: MIT
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import * as readline from 'node:readline';
import { parseIp } from '../../ip';
import type { NormalizedRecord } from '../../types';

export async function parseDbipCsv(gzPath: string): Promise<NormalizedRecord[]> {
  const raw = fs.readFileSync(gzPath);
  const csv = zlib.gunzipSync(raw).toString('utf8');
  const lines = csv.split('\n').filter(Boolean);
  const records: NormalizedRecord[] = [];
  for (let i = 1; i < lines.length; i++) { // skip header
    const cols = lines[i]!.split(',');
    if (cols.length < 4) continue;
    const start = parseIp(cols[0]!);
    const end = parseIp(cols[1]!);
    if (!start || !end) continue;
    const rec: NormalizedRecord = { startIp: start, endIp: end, source: 'dbip' };
    if (cols[2]) rec.countryCode = cols[2];
    if (cols[3]) rec.region = cols[3];
    if (cols[4]) rec.city = cols[4];
    records.push(rec);
  }
  return records;
}

void readline;
// SPDX-License-Identifier: MIT
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import * as readline from 'node:readline';
import { parseIp } from '../../ip';
import type { NormalizedRecord } from '../../types';

// Stream-parse the gzipped CSV. The naive readFileSync + gunzipSync + toString
// blows Node's single-string limit (~512 MB) on the real DB-IP city-lite
// dataset (~706 MB uncompressed); materialising the full row array on top
// of that also exhausts the V8 heap at ~7.9M rows. We yield one record at a
// time so callers can stream them straight into MySQL.
async function* parseDbipCsvLines(gzPath: string): AsyncIterable<NormalizedRecord> {
  const gunzip = zlib.createGunzip();
  const fileStream = fs.createReadStream(gzPath);
  const lines = readline.createInterface({ input: fileStream.pipe(gunzip), crlfDelay: Infinity });
  let isFirst = true;
  for await (const line of lines) {
    if (isFirst) { isFirst = false; continue; }
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 4) continue;
    const start = parseIp(cols[0]!);
    const end = parseIp(cols[1]!);
    if (!start || !end) continue;
    const rec: NormalizedRecord = { startIp: start, endIp: end, source: 'dbip' };
    if (cols[2]) rec.countryCode = cols[2];
    if (cols[3]) rec.region = cols[3];
    if (cols[4]) rec.city = cols[4];
    yield rec;
  }
}

export async function* parseDbipCsvStream(gzPath: string): AsyncIterable<NormalizedRecord> {
  yield* parseDbipCsvLines(gzPath);
}

export async function parseDbipCsv(gzPath: string): Promise<NormalizedRecord[]> {
  const records: NormalizedRecord[] = [];
  for await (const rec of parseDbipCsvLines(gzPath)) records.push(rec);
  return records;
}

// SPDX-License-Identifier: MIT
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import * as readline from 'node:readline';
import { parseIp } from '../../ip';
import type { NormalizedRecord } from '../../types';

// DB-IP distributes its free data as separate CSV.gz files, one per
// information slice. All three cover the same IP ranges (a row in the
// country-lite file points at the same start/end IPs as the matching row
// in the city-lite file), so the cross-source `mergeByPriority` merger
// in ../merger.ts is what stitches them together per segment.
//
// Column layouts we consume:
//
//   city-lite   : start, end, continent, country, region, city, lat, lon
//   country-lite: start, end, country
//   asn-lite    : start, end, asn, asn_org
//
// The naive readFileSync + gunzipSync + toString blows Node's single-string
// limit (~512 MB) on the full city-lite set (~706 MB uncompressed), and
// materialising the full NormalizedRecord[] exhausts the 4 GB V8 heap at
// ~7.9M rows. Each parser below streams one record at a time so callers
// can route rows straight into the new table without keeping the array
// resident.
function parseInt10(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function parseDec(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

// Minimal RFC 4180-ish CSV line parser: handles double-quoted fields that
// may contain commas and `""`-escaped quotes. Doesn't handle embedded
// newlines because DB-IP rows don't have them.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { out.push(''); break; }
    if (line[i] === '"') {
      let buf = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { buf += '"'; i += 2; continue; }
        if (line[i] === '"') { i++; break; }
        buf += line[i]!;
        i++;
      }
      out.push(buf);
      if (i < line.length && line[i] === ',') i++;
    } else {
      let j = i;
      while (j < line.length && line[j] !== ',') j++;
      out.push(line.slice(i, j));
      i = j + 1;
    }
  }
  return out;
}

async function* streamGzippedCsv(
  gzPath: string, header: boolean,
): AsyncIterable<string[]> {
  const gunzip = zlib.createGunzip();
  const fileStream = fs.createReadStream(gzPath);
  const lines = readline.createInterface({ input: fileStream.pipe(gunzip), crlfDelay: Infinity });
  let isFirst = true;
  for await (const line of lines) {
    if (!line) continue;
    if (isFirst) { isFirst = false; if (header) continue; }
    yield parseCsvLine(line);
  }
}

function isHeaderRow(cols: string[]): boolean {
  return cols[0] === 'ip_start' || cols[0] === 'start_ip';
}

// Skip-counter buckets returned by the *WithStats parsers below. Mirrors
// the columns on etl_run_parses so the pipeline can persist the result
// directly without remapping.
export interface ParseSkipCounters {
  shortLine: number;
  headerRow: number;
  unparseableIp: number;
  missingCol: number;
  nonNumericAsn: number;
  other: number;
}

export interface ParseStats {
  rowsEmitted: number;
  skipped: ParseSkipCounters;
  gunzipErrors: number;
}

export interface ParseStreamResult {
  records: AsyncIterable<NormalizedRecord>;
  stats: ParseStats;
}

function newStats(): ParseStats {
  return {
    rowsEmitted: 0,
    skipped: { shortLine: 0, headerRow: 0, unparseableIp: 0, missingCol: 0, nonNumericAsn: 0, other: 0 },
    gunzipErrors: 0,
  };
}

async function* parseDbipCityLines(
  gzPath: string, stats: ParseStats,
): AsyncIterable<NormalizedRecord> {
  for await (const cols of streamGzippedCsv(gzPath, true)) {
    if (cols.length < 5) { stats.skipped.shortLine++; continue; }
    if (isHeaderRow(cols)) { stats.skipped.headerRow++; continue; }
    const start = parseIp(cols[0]!);
    const end = parseIp(cols[1]!);
    if (!start || !end) { stats.skipped.unparseableIp++; continue; }
    const rec: NormalizedRecord = { startIp: start, endIp: end, source: 'dbip' };
    // cols[3] is the ISO country code; cols[2] is the continent code we ignore.
    if (cols[3]) rec.countryCode = cols[3];
    if (cols[4]) rec.region = cols[4];
    if (cols[5]) rec.city = cols[5];
    const lat = parseDec(cols[6]);
    if (lat !== undefined) rec.latitude = lat;
    const lon = parseDec(cols[7]);
    if (lon !== undefined) rec.longitude = lon;
    stats.rowsEmitted++;
    yield rec;
  }
}

async function* parseDbipCountryLines(
  gzPath: string, stats: ParseStats,
): AsyncIterable<NormalizedRecord> {
  for await (const cols of streamGzippedCsv(gzPath, true)) {
    if (cols.length < 3) { stats.skipped.shortLine++; continue; }
    if (isHeaderRow(cols)) { stats.skipped.headerRow++; continue; }
    const start = parseIp(cols[0]!);
    const end = parseIp(cols[1]!);
    if (!start || !end) { stats.skipped.unparseableIp++; continue; }
    const rec: NormalizedRecord = { startIp: start, endIp: end, source: 'dbip' };
    if (cols[2]) rec.countryCode = cols[2];
    stats.rowsEmitted++;
    yield rec;
  }
}

async function* parseDbipAsnLines(
  gzPath: string, stats: ParseStats,
): AsyncIterable<NormalizedRecord> {
  for await (const cols of streamGzippedCsv(gzPath, true)) {
    if (cols.length < 4) { stats.skipped.shortLine++; continue; }
    if (isHeaderRow(cols)) { stats.skipped.headerRow++; continue; }
    const start = parseIp(cols[0]!);
    const end = parseIp(cols[1]!);
    if (!start || !end) { stats.skipped.unparseableIp++; continue; }
    const rec: NormalizedRecord = { startIp: start, endIp: end, source: 'dbip' };
    const asn = parseInt10(cols[2]);
    if (asn !== undefined) {
      rec.asn = asn;
    } else {
      // cols[2] present but not a clean integer — track it so the admin
      // run-detail page can show "X rows had a non-numeric ASN" without
      // the caller having to compare against the file separately. The
      // row is still yielded (preserves the legacy behaviour where the
      // record is emitted with asn undefined).
      stats.skipped.nonNumericAsn++;
    }
    if (cols[3]) rec.asnOrg = cols[3];
    stats.rowsEmitted++;
    yield rec;
  }
}

// City-lite: country + region + city + (lat,lon ignored).
// Streaming variants are the production path; array variants stay for tests.
export async function* parseDbipCityCsvStream(gzPath: string): AsyncIterable<NormalizedRecord> {
  const { records } = parseDbipCityCsvStreamWithStats(gzPath);
  yield* records;
}
export async function parseDbipCityCsv(gzPath: string): Promise<NormalizedRecord[]> {
  const out: NormalizedRecord[] = [];
  for await (const r of parseDbipCityLines(gzPath, newStats())) out.push(r);
  return out;
}
export function parseDbipCityCsvStreamWithStats(gzPath: string): ParseStreamResult {
  const stats = newStats();
  return { records: parseDbipCityLines(gzPath, stats), stats };
}

// Country-lite: country code only.
export async function* parseDbipCountryCsvStream(gzPath: string): AsyncIterable<NormalizedRecord> {
  const { records } = parseDbipCountryCsvStreamWithStats(gzPath);
  yield* records;
}
export async function parseDbipCountryCsv(gzPath: string): Promise<NormalizedRecord[]> {
  const out: NormalizedRecord[] = [];
  for await (const r of parseDbipCountryLines(gzPath, newStats())) out.push(r);
  return out;
}
export function parseDbipCountryCsvStreamWithStats(gzPath: string): ParseStreamResult {
  const stats = newStats();
  return { records: parseDbipCountryLines(gzPath, stats), stats };
}

// ASN-lite: ASN number + ASN organization.
export async function* parseDbipAsnCsvStream(gzPath: string): AsyncIterable<NormalizedRecord> {
  const { records } = parseDbipAsnCsvStreamWithStats(gzPath);
  yield* records;
}
export async function parseDbipAsnCsv(gzPath: string): Promise<NormalizedRecord[]> {
  const out: NormalizedRecord[] = [];
  for await (const r of parseDbipAsnLines(gzPath, newStats())) out.push(r);
  return out;
}
export function parseDbipAsnCsvStreamWithStats(gzPath: string): ParseStreamResult {
  const stats = newStats();
  return { records: parseDbipAsnLines(gzPath, stats), stats };
}

// Backwards-compatible aliases: the original parseDbipCsv referred to the
// city file. Existing tests and pipeline paths use these names.
export const parseDbipCsv = parseDbipCityCsv;
export const parseDbipCsvStream = parseDbipCityCsvStream;
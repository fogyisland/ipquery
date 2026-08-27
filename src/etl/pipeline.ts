// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as mysql from 'mysql2/promise';
import { createPool, runMigrations, truncateNew, insertIntoNewUpsert, atomicSwapRanges, recordEtlStart, recordEtlFinish } from '../storage/mysql';
import { parseDbipCityCsvStream, parseDbipCountryCsvStream, parseDbipAsnCsvStream } from './sources/dbip';
import type { AppConfig } from '../config';
import type { Source, NormalizedRecord, IpRangeRow } from '../types';

// A streaming ingest target: one physical file from one logical source.
// `fillCols` says which columns this file contributes; the upsert path in
// storage/mysql.ts uses that to gate INSERT ... ON DUPLICATE KEY UPDATE so
// a later, lower-priority file (inserted later) doesn't clobber a value
// already filled by an earlier, higher-priority one. Higher priority wins
// because COALESCE(existing, new) keeps the already-present value.
interface StreamFile {
  source: Source;
  filename: string;
  parse: (p: string) => AsyncIterable<NormalizedRecord>;
  fillCols: ReadonlySet<keyof IpRangeRow>;
}

// Priority order matches the cross-source merger: insert maxmind first if
// present, then ip2region, then DB-IP files (city, country, asn).
const DBIP_FILES: StreamFile[] = [
  {
    source: 'dbip',
    filename: 'dbip.csv.gz',
    parse: parseDbipCityCsvStream,
    fillCols: new Set<keyof IpRangeRow>([
      'countryCode', 'region', 'city', 'latitude', 'longitude',
      'countrySource', 'citySource', 'geoSource',
    ]),
  },
  {
    source: 'dbip-country',
    filename: 'dbip-country.csv.gz',
    parse: parseDbipCountryCsvStream,
    fillCols: new Set<keyof IpRangeRow>(['countryCode', 'countrySource']),
  },
  {
    source: 'dbip-asn',
    filename: 'dbip-asn.csv.gz',
    parse: parseDbipAsnCsvStream,
    fillCols: new Set<keyof IpRangeRow>(['asn', 'asnOrg', 'asnSource']),
  },
];

export interface PipelineResult { runId: number; merged: number; }

async function ensurePool(cfg: AppConfig): Promise<mysql.Pool> {
  const pool = createPool(cfg);
  await runMigrations(pool);
  return pool;
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function toIpRangeRow(rec: NormalizedRecord, source: Source, fillCols: ReadonlySet<keyof IpRangeRow>): IpRangeRow {
  const row: IpRangeRow = { startIp: rec.startIp, endIp: rec.endIp };
  if (fillCols.has('countryCode') && rec.countryCode) {
    row.countryCode = rec.countryCode;
    if (fillCols.has('countrySource')) row.countrySource = source;
  }
  if (fillCols.has('region') && rec.region) row.region = rec.region;
  if (fillCols.has('city') && rec.city) {
    row.city = rec.city;
    if (fillCols.has('citySource')) row.citySource = source;
  }
  if (fillCols.has('latitude') && rec.latitude !== undefined) {
    row.latitude = rec.latitude;
    if (fillCols.has('geoSource')) row.geoSource = source;
  }
  if (fillCols.has('longitude') && rec.longitude !== undefined) row.longitude = rec.longitude;
  if (fillCols.has('asn') && rec.asn !== undefined) {
    row.asn = rec.asn;
    if (fillCols.has('asnSource')) row.asnSource = source;
  }
  if (fillCols.has('asnOrg') && rec.asnOrg) row.asnOrg = rec.asnOrg;
  return row;
}

// Streaming ingest: walks the parser one record at a time and flushes
// 1000-row batches into `ip_ranges_new` via INSERT ... ON DUPLICATE KEY
// UPDATE. Never materialises the full row array — this is what keeps the
// 7.9M-row DB-IP city-lite set from exhausting the V8 heap.
async function streamFileToDb(pool: mysql.Pool, file: StreamFile, fullPath: string): Promise<number> {
  let count = 0;
  let batch: IpRangeRow[] = [];
  for await (const rec of file.parse(fullPath)) {
    batch.push(toIpRangeRow(rec, file.source, file.fillCols));
    if (batch.length >= 1000) {
      await insertIntoNewUpsert(pool, batch, file.fillCols);
      count += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insertIntoNewUpsert(pool, batch, file.fillCols);
    count += batch.length;
  }
  return count;
}

export async function runPipeline(opts: { cfg: AppConfig; runId?: number }): Promise<PipelineResult> {
  const { cfg } = opts;
  const pool = await ensurePool(cfg);
  // If the caller already created a row via recordEtlStart (e.g. the setup
  // wizard needs the runId for its progress page BEFORE the pipeline spins
  // up), reuse that id instead of inserting a new one. Saves a few hundred ms
  // of waiting on the redirect→progress page round trip.
  const runId = opts.runId ?? await recordEtlStart(pool);
  const rawDir = path.join(cfg.etl.dataDir, 'raw');

  try {
    const presentDbip: StreamFile[] = [];
    for (const f of DBIP_FILES) {
      if (await fileExists(path.join(rawDir, f.filename))) presentDbip.push(f);
    }

    await truncateNew(pool);

    const counts = new Map<Source, number>();
    for (const f of presentDbip) {
      counts.set(f.source, await streamFileToDb(pool, f, path.join(rawDir, f.filename)));
    }

    await atomicSwapRanges(pool);

    const dbipRecords = counts.get('dbip') ?? 0;
    const dbipCountryRecords = counts.get('dbip-country') ?? 0;
    const dbipAsnRecords = counts.get('dbip-asn') ?? 0;
    const total = dbipRecords + dbipCountryRecords + dbipAsnRecords;
    await recordEtlFinish(pool, runId, 'success', {
      dbipRecords: total,
      mergedRecords: total,
    });
    console.log(`[etl] success run=${runId} merged=${total} (dbip=${dbipRecords}, dbip-country=${dbipCountryRecords}, dbip-asn=${dbipAsnRecords})`);
    return { runId, merged: total };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordEtlFinish(pool, runId, 'failed', { errorMessage: msg });
    console.error(`[etl] failed run=${runId}:`, msg);
    throw err;
  } finally {
    await pool.end();
  }
}
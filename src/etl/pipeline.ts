// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as mysql from 'mysql2/promise';
import { createPool, runMigrations, truncateNew, insertIntoNew, atomicSwapRanges, recordEtlStart, recordEtlFinish } from '../storage/mysql';
import { parseDbipCsv, parseDbipCsvStream } from './sources/dbip';
import { parseIp2regionXdb } from './sources/ip2region';
import { parseMaxmindMmdb } from './sources/maxmind';
import { mergeByPriority } from './merger';
import type { AppConfig } from '../config';
import type { Source, NormalizedRecord, IpRangeRow } from '../types';

const PRIORITY: Source[] = ['maxmind', 'ip2region', 'dbip'];
const SOURCE_FILES: Record<Source, string> = { maxmind: 'maxmind.mmdb', ip2region: 'ip2region.xdb', dbip: 'dbip.csv.gz' };

export interface PipelineResult { runId: number; merged: number; }

async function ensurePool(cfg: AppConfig): Promise<mysql.Pool> {
  const pool = createPool(cfg);
  await runMigrations(pool);
  return pool;
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function loadLocalSource(
  rawDir: string, filename: string, parser: (p: string) => Promise<NormalizedRecord[]>,
): Promise<NormalizedRecord[]> {
  const p = path.join(rawDir, filename);
  if (!(await fileExists(p))) {
    console.warn(`[etl] source file missing, skipping: ${p}`);
    return [];
  }
  try {
    return await parser(p);
  } catch (err) {
    console.error(`[etl] source parse failed for ${filename}:`, err);
    return [];
  }
}

// Single-source fast path: stream rows straight from the DB-IP gzipped CSV
// into `ip_ranges_new` in batches of 1000, never materialising the full row
// array. Skips the priority merger (which assumes multiple sources). DB-IP
// city-lite rows are non-overlapping by construction, so a 1:1 row insert
// is correct without range consolidation.
async function streamDbipToDb(pool: mysql.Pool, gzPath: string): Promise<number> {
  let count = 0;
  let batch: IpRangeRow[] = [];
  for await (const rec of parseDbipCsvStream(gzPath)) {
    const row: IpRangeRow = { startIp: rec.startIp, endIp: rec.endIp };
    if (rec.countryCode) {
      row.countryCode = rec.countryCode;
      row.countrySource = 'dbip';
    }
    if (rec.region) row.region = rec.region;
    if (rec.city) {
      row.city = rec.city;
      row.citySource = 'dbip';
    }
    batch.push(row);
    if (batch.length >= 1000) {
      await insertIntoNew(pool, batch);
      count += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insertIntoNew(pool, batch);
    count += batch.length;
  }
  return count;
}

export async function runPipeline(opts: { cfg: AppConfig }): Promise<PipelineResult> {
  const { cfg } = opts;
  const pool = await ensurePool(cfg);
  const runId = await recordEtlStart(pool);
  const rawDir = path.join(cfg.etl.dataDir, 'raw');

  try {
    const present = (await Promise.all(
      PRIORITY.map(async (src) => (await fileExists(path.join(rawDir, SOURCE_FILES[src]))) ? src : null),
    )).filter((s): s is Source => s !== null);

    await truncateNew(pool);

    let maxmindRecords = 0;
    let ip2regionRecords = 0;
    let dbipRecords = 0;

    if (present.length === 1 && present[0] === 'dbip') {
      // DB-IP-only fast path: stream rows from disk to MySQL without
      // materialising the ~7.9M-row array (which exhausts the V8 heap).
      dbipRecords = await streamDbipToDb(pool, path.join(rawDir, SOURCE_FILES.dbip));
    } else {
      // General path: load every present source into memory and merge by
      // priority. Multi-source merger still requires all data resident, so
      // this path stays materialising.
      const [maxmind, ip2region, dbip] = await Promise.all([
        loadLocalSource(rawDir, SOURCE_FILES.maxmind, (p) => parseMaxmindMmdb(p, 'city')),
        loadLocalSource(rawDir, SOURCE_FILES.ip2region, parseIp2regionXdb),
        loadLocalSource(rawDir, SOURCE_FILES.dbip, parseDbipCsv),
      ]);
      maxmindRecords = maxmind.length;
      ip2regionRecords = ip2region.length;
      dbipRecords = dbip.length;
      const bySource = new Map<Source, NormalizedRecord[]>();
      bySource.set('maxmind', maxmind);
      bySource.set('ip2region', ip2region);
      bySource.set('dbip', dbip);
      const merged = mergeByPriority(bySource, PRIORITY);
      await insertIntoNew(pool, merged);
    }

    await atomicSwapRanges(pool);

    const total = maxmindRecords + ip2regionRecords + dbipRecords;
    await recordEtlFinish(pool, runId, 'success', {
      maxmindRecords,
      ip2regionRecords,
      dbipRecords,
      mergedRecords: total,
    });
    console.log(`[etl] success run=${runId} merged=${total} (maxmind=${maxmindRecords}, ip2region=${ip2regionRecords}, dbip=${dbipRecords})`);
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

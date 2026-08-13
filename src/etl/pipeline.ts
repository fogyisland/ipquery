// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as mysql from 'mysql2/promise';
import { createPool, initSchema, truncateNew, insertIntoNew, atomicSwapRanges, recordEtlStart, recordEtlFinish } from '../storage/mysql';
import { parseDbipCsv } from './sources/dbip';
import { parseIp2regionXdb } from './sources/ip2region';
import { parseMaxmindMmdb } from './sources/maxmind';
import { mergeByPriority } from './merger';
import type { AppConfig } from '../config';
import type { Source, NormalizedRecord } from '../types';

const PRIORITY: Source[] = ['maxmind', 'ip2region', 'dbip'];

export interface PipelineResult { runId: number; merged: number; }

async function ensurePool(cfg: AppConfig): Promise<mysql.Pool> {
  const pool = createPool(cfg);
  await initSchema(pool);
  return pool;
}

async function loadLocalSource(
  rawDir: string, filename: string, parser: (p: string) => Promise<NormalizedRecord[]>,
): Promise<NormalizedRecord[]> {
  const p = path.join(rawDir, filename);
  try {
    await fs.access(p);
  } catch {
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

export async function runPipeline(opts: { cfg: AppConfig }): Promise<PipelineResult> {
  const { cfg } = opts;
  const pool = await ensurePool(cfg);
  const runId = await recordEtlStart(pool);
  const rawDir = path.join(cfg.etl.dataDir, 'raw');

  try {
    const [maxmind, ip2region, dbip] = await Promise.all([
      loadLocalSource(rawDir, 'maxmind.mmdb', (p) => parseMaxmindMmdb(p, 'city')),
      loadLocalSource(rawDir, 'ip2region.xdb', parseIp2regionXdb),
      loadLocalSource(rawDir, 'dbip.csv.gz', parseDbipCsv),
    ]);

    const bySource = new Map<Source, NormalizedRecord[]>();
    bySource.set('maxmind', maxmind);
    bySource.set('ip2region', ip2region);
    bySource.set('dbip', dbip);

    const merged = mergeByPriority(bySource, PRIORITY);

    await truncateNew(pool);
    await insertIntoNew(pool, merged);
    await atomicSwapRanges(pool);

    await recordEtlFinish(pool, runId, 'success', {
      maxmindRecords: maxmind.length,
      ip2regionRecords: ip2region.length,
      dbipRecords: dbip.length,
      mergedRecords: merged.length,
    });
    console.log(`[etl] success run=${runId} merged=${merged.length} (maxmind=${maxmind.length}, ip2region=${ip2region.length}, dbip=${dbip.length})`);
    return { runId, merged: merged.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordEtlFinish(pool, runId, 'failed', { errorMessage: msg });
    console.error(`[etl] failed run=${runId}:`, msg);
    throw err;
  } finally {
    await pool.end();
  }
}

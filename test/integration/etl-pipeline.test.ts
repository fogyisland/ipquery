import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mysql from 'mysql2/promise';
import { createPool, runMigrations, findRange, lastEtlRun } from '../../src/storage/mysql';
import { runPipeline } from '../../src/etl/pipeline';
import { loadConfig } from '../../src/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const TEST_DB = 'ipquery_test';
let pool: mysql.Pool;
let cfg = loadConfig();

beforeAll(async () => {
  cfg.db.database = TEST_DB;
  cfg.etl.dataDir = path.join(__dirname, '..', 'tmp-data');
  await fs.mkdir(cfg.etl.dataDir, { recursive: true });

  // Lay down fixture files into dataDir/raw
  const rawDir = path.join(cfg.etl.dataDir, 'raw');
  await fs.mkdir(rawDir, { recursive: true });

  // DB-IP city-lite column layout: start, end, continent, country, region,
  // city, lat, lon. The parser indexes cols[3] as the ISO country code
  // (cols[2] is the continent we ignore), so the column order matters.
  const csv = 'ip_start,ip_end,continent,country,stateprov,city,latitude,longitude\n9.9.9.0,9.9.9.255,EU,GB,England,London,51.5074,-0.1278\n';
  await fs.writeFile(path.join(rawDir, 'dbip.csv.gz'), zlib.gzipSync(Buffer.from(csv)));
  await fs.writeFile(path.join(rawDir, 'ip2region.xdb'), JSON.stringify([
    { start: '9.9.9.0', end: '9.9.9.255', country: '英国', city: 'London' },
  ]));
  // Re-use the existing maxmind-sample.mmdb from fixtures/
  await fs.copyFile(
    path.join(__dirname, '..', '..', 'fixtures', 'maxmind-sample.mmdb'),
    path.join(rawDir, 'maxmind.mmdb'),
  );

  const root = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.query(`CREATE DATABASE ${TEST_DB}`);
  await root.end();
  pool = createPool(cfg);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
  const root = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.end();
  await fs.rm(cfg.etl.dataDir, { recursive: true, force: true });
});

describe('etl pipeline', () => {
  it('runs end-to-end and populates ip_ranges', async () => {
    const result = await runPipeline({ cfg });
    expect(result.merged).toBeGreaterThan(0);
    const last = await lastEtlRun(pool);
    expect(last?.status).toBe('success');
  });

  it('subsequent /lookup finds seeded data', async () => {
    const r = await findRange(pool, Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0,9,9,9,5]));
    expect(r?.countryCode).toBeDefined();
  });
});

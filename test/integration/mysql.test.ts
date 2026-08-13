import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mysql from 'mysql2/promise';
import { createPool, initSchema, atomicSwapRanges, insertIntoNew, truncateNew, findRange, recordEtlStart, recordEtlFinish, lastEtlRun } from '../../src/storage/mysql';
import { loadConfig } from '../../src/config';

const TEST_DB = 'ipquery_test';

describe('mysql storage', () => {
  let pool: mysql.Pool;
  const cfg = loadConfig();

  beforeAll(async () => {
    cfg.db.database = TEST_DB;
    const root = await mysql.createConnection({
      host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
    });
    await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await root.query(`CREATE DATABASE ${TEST_DB}`);
    await root.end();
    pool = createPool(cfg);
    await initSchema(pool);
  });

  afterAll(async () => {
    await pool.end();
    const root = await mysql.createConnection({
      host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
    });
    await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await root.end();
  });

  it('initSchema creates tables', async () => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ?`,
      [TEST_DB]
    );
    const names = rows.map(r => r.TABLE_NAME).sort();
    expect(names).toEqual(['etl_runs', 'ip_ranges', 'ip_ranges_new']);
  });

  it('insertIntoNew + atomicSwapRanges moves data', async () => {
    await truncateNew(pool);
    const row = {
      startIp: Buffer.from([0,0,0,0,0,0,0,0,0,0,0xff,0xff,8,8,8,0]),
      endIp:   Buffer.from([0,0,0,0,0,0,0,0,0,0,0xff,0xff,8,8,8,255]),
      countryCode: 'US', countryName: 'United States', city: 'Mountain View',
      countrySource: 'maxmind' as const, citySource: 'maxmind' as const,
    };
    await insertIntoNew(pool, [row]);
    await atomicSwapRanges(pool);
    const found = await findRange(pool, Buffer.from([0,0,0,0,0,0,0,0,0,0,0xff,0xff,8,8,8,8]));
    expect(found?.countryCode).toBe('US');
    expect(found?.city).toBe('Mountain View');
  });

  it('records ETL start/finish and reads back', async () => {
    const id = await recordEtlStart(pool);
    expect(id).toBeGreaterThan(0);
    await recordEtlFinish(pool, id, 'success', { mergedRecords: 100 });
    const last = await lastEtlRun(pool);
    expect(last?.status).toBe('success');
    expect(last?.mergedRecords).toBe(100);
  });
});

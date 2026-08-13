// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as mysql from 'mysql2/promise';
import { buildServer } from '../../src/api/server';
import { loadConfig } from '../../src/config';
import { createPool, initSchema, truncateNew, insertIntoNew, atomicSwapRanges } from '../../src/storage/mysql';

const TEST_DB = 'ipquery_lookup_test';
let cfg = loadConfig();
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  cfg.db.database = TEST_DB;
  const root = await mysql.createConnection({ host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.query(`CREATE DATABASE ${TEST_DB}`);
  await root.end();
  const pool = createPool(cfg);
  await initSchema(pool);
  await truncateNew(pool);
  await insertIntoNew(pool, [{
    startIp: Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0,8,8,8,0]),
    endIp:   Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0,8,8,8,255]),
    countryCode: 'US', countryName: 'United States', city: 'Mountain View',
    latitude: 37.4056, longitude: -122.0775, timezone: 'America/Los_Angeles',
    countrySource: 'maxmind', citySource: 'maxmind', geoSource: 'maxmind',
  }]);
  await atomicSwapRanges(pool);
  await pool.end();
  app = await buildServer(cfg);
});
afterAll(async () => {
  await app.close();
  const root = await mysql.createConnection({ host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.end();
});

describe('lookup route', () => {
  it('returns 200 with country for query string', async () => {
    const res = await request(app.server).get('/lookup').query({ ip: '8.8.8.8' });
    expect(res.status).toBe(200);
    expect(res.body.country.code).toBe('US');
    expect(res.body.city.name).toBe('Mountain View');
    expect(res.body.location.lat).toBe(37.4056);
    expect(res.body.etag).toBeDefined();
  });

  it('returns 200 with path-style URL', async () => {
    const res = await request(app.server).get('/lookup/8.8.8.8');
    expect(res.status).toBe(200);
    expect(res.body.country.code).toBe('US');
  });

  it('returns 400 on missing ip', async () => {
    const res = await request(app.server).get('/lookup');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_ip');
  });

  it('returns 400 on malformed ip', async () => {
    const res = await request(app.server).get('/lookup').query({ ip: 'not.an.ip' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unmatched IP', async () => {
    const res = await request(app.server).get('/lookup').query({ ip: '192.168.1.1' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { truncateNew, insertIntoNew, atomicSwapRanges } from '../../src/storage/mysql';
import { createUser } from '../../src/storage/users';
import { createApiKey, findApiKeyById } from '../../src/storage/apiKeys';
import { generateApiKey, hashToken } from '../../src/web/auth/tokens';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let rawKey: string;
let keyId: number;
let cfg = loadConfig();

beforeAll(async () => {
  td = await createTestDb('lookup_auth');
  cfg.db.database = td.dbName;
  // Seed an IP range at 8.8.8.8 (need this BEFORE building server so atomicSwap happens once)
  const seedPool = td.pool;
  await truncateNew(seedPool);
  await insertIntoNew(seedPool, [{
    startIp: Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0,8,8,8,0]),
    endIp:   Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0,8,8,8,255]),
    countryCode: 'US', countryName: 'United States', city: 'Mountain View',
    latitude: 37.4056, longitude: -122.0775, timezone: 'America/Los_Angeles',
    countrySource: 'maxmind', citySource: 'maxmind', geoSource: 'maxmind',
  }]);
  await atomicSwapRanges(seedPool);
  // Build server against this DB
  app = await buildServer(cfg);
  // Create user + API key
  const u = await createUser(app.pool, { email: 'auth@test', passwordHash: 'h', displayName: 'Auth' });
  rawKey = generateApiKey();
  const key = await createApiKey(app.pool, u.id, 'auth-test', hashToken(rawKey), rawKey.slice(0, 8));
  keyId = key.id;
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe('GET /lookup API key auth', () => {
  it('rejects unknown key with 401', async () => {
    const bogus = 'ipq_bogusbogusbogusbogusbogusbogusbogusbogusbogusbogu';
    const res = await request(app.server).get('/lookup').query({ ip: '8.8.8.8', key: bogus });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_api_key' });
  });

  it('accepts key via ?key= query', async () => {
    const res = await request(app.server).get('/lookup').query({ ip: '8.8.8.8', key: rawKey });
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('8.8.8.8');
    expect(res.body.country.code).toBe('US');
  });

  it('accepts key via Authorization: Bearer header', async () => {
    const res = await request(app.server).get('/lookup').query({ ip: '8.8.8.8' })
      .set('Authorization', `Bearer ${rawKey}`);
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('8.8.8.8');
  });

  it('still allows unauthenticated lookup (no key → 200)', async () => {
    const res = await request(app.server).get('/lookup').query({ ip: '8.8.8.8' });
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('8.8.8.8');
  });

  it('accepts key on path-style /lookup/:ip', async () => {
    const res = await request(app.server).get(`/lookup/8.8.8.8`).query({ key: rawKey });
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('8.8.8.8');
  });

  it('stamps api_keys.last_used_at after a successful lookup', async () => {
    // Pre-MVP parked follow-up: touchApiKey was defined but never wired up;
    // /dashboard/keys therefore showed "Last used: never" for every key.
    // Earlier tests in this suite already exercised rawKey and stamped the
    // column, so reset to NULL here to make the post-call assertion checkable.
    await app.pool.query(`UPDATE api_keys SET last_used_at = NULL WHERE id = ?`, [keyId]);
    const before = await findApiKeyById(app.pool, keyId);
    expect(before?.lastUsedAt).toBeNull();
    const t0 = Date.now();
    const res = await request(app.server).get('/lookup').query({ ip: '8.8.8.8', key: rawKey });
    expect(res.status).toBe(200);
    const after = await findApiKeyById(app.pool, keyId);
    expect(after?.lastUsedAt).not.toBeNull();
    expect(after!.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
  });
});

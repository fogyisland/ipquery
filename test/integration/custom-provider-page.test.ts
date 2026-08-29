// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { generateToken } from '../../src/web/auth/tokens';
import { _resetProviderHealthCache } from '../../src/storage/providerErrorLog';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]),
}));

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb('custom-prov-page');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: 'a@x.com', passwordHash: 'h', displayName: 'A', role: 'admin',
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});

afterAll(async () => { await app.close(); await dropTestDb(td); });

beforeEach(async () => {
  _resetProviderHealthCache();
  await td.pool.query(`TRUNCATE TABLE provider_call_counter`);
  await td.pool.query(`DELETE FROM ingest_providers WHERE is_custom = 1`);
});

describe('GET /admin/unknown-ips/providers/custom', () => {
  it('renders the add form and an empty list', async () => {
    const r = await request(app.server).get('/admin/unknown-ips/providers/custom').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/添加自定义 Provider/);
    expect(r.text).toMatch(/urlTemplate/);
    expect(r.text).toMatch(/尚未注册/);
  });

  it('lists seeded custom providers with health stats', async () => {
    // Seed one custom provider with a known counter row.
    await td.pool.query(
      `INSERT INTO ingest_providers
         (name, display_name, free_quota, enabled, is_custom,
          custom_url_template, custom_method, custom_response_format, custom_country_path)
       VALUES ('demo', 'Demo Provider', '', 1, 1,
          'https://api.example.com/{ip}', 'GET', 'json', 'country.code')`,
    );
    await td.pool.query(
      `INSERT INTO provider_call_counter
         (provider_name, day_utc, calls_total, calls_429, calls_timeout,
          calls_network_err, calls_other_err, last_called_at)
       VALUES ('demo', CURDATE(), 50, 5, 0, 0, 0, NOW(3))`,
    );

    const r = await request(app.server).get('/admin/unknown-ips/providers/custom').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    // Provider name + slug rendered.
    expect(r.text).toMatch(/Demo Provider/);
    expect(r.text).toMatch(/<code class="provider-health-card-slug">demo<\/code>/);
    // URL template rendered inside the stat block.
    expect(r.text).toMatch(/api\.example\.com/);
    // 24h call count rendered.
    expect(r.text).toMatch(/50.*调用/);
    // Window labels render.
    expect(r.text).toMatch(/1 小时/);
    expect(r.text).toMatch(/24 小时/);
    expect(r.text).toMatch(/7 天/);
  });
});

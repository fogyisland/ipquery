// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { generateToken } from '../../src/web/auth/tokens';
import { _resetProviderHealthCache } from '../../src/storage/providerErrorLog';
import { recordProviderError } from '../../src/storage/providerErrorLog';
import { updateProviderConfig } from '../../src/storage/ingestProviders';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb('unk-card');
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
  await td.pool.query('TRUNCATE TABLE provider_call_counter');
  await td.pool.query('TRUNCATE TABLE provider_error_log');
  _resetProviderHealthCache();
  // Reset all providers to enabled so per-test re-enables don't leak.
  for (const name of ['ip-api', 'ipinfo', 'iplocate', 'freeipapi', 'ipapi-co']) {
    await updateProviderConfig(td.pool, name, {
      enabled: true, autoReenableAt: null, autoDisabledReason: null,
    });
  }
});

describe('GET /admin/unknown-ips — provider health card', () => {
  it('renders 1h/24h/7d window stats + today quota pill + 429 detail block when seeded', async () => {
    // Seed counter rows: ip-api has 100 calls with 12 of them being 429s.
    // Per-minute quota is 45 for ip-api, so daily cap = 45*60*24 = 64,800.
    // 100/64,800 = 0.15% — well under 80%, so success pill.
    await td.pool.query(
      `INSERT INTO provider_call_counter
         (provider_name, day_utc, calls_total, calls_429, calls_timeout,
          calls_network_err, calls_other_err, last_called_at)
       VALUES ('ip-api', CURDATE(), 100, 12, 0, 0, 0, NOW(3))`,
    );
    // Seed a recent 429 row so the <details> block renders. Use a unique
    // raw response string we can search for.
    await recordProviderError(td.pool, {
      providerName: 'ip-api',
      ipText: '203.0.113.42',
      mode: 'auto',
      errorCode: '429',
      reason: 'HTTP 429 Too Many Requests',
      rawResponse: 'throttled by upstream',
    });

    const r = await request(app.server).get('/admin/unknown-ips?tab=providers').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    // Window labels rendered (Chinese locale is the default).
    expect(r.text).toMatch(/1 小时/);
    expect(r.text).toMatch(/24 小时/);
    expect(r.text).toMatch(/7 天/);
    // Calls / 429s / failure-rate labels rendered.
    expect(r.text).toMatch(/429 限流/);
    expect(r.text).toMatch(/失败率/);
    // Quota pill rendered (the per-minute quota × 24h × 60 = 64,800,
    // 100/64,800 rounded to 0%, but the pill text still includes the
    // "今日配额" prefix).
    expect(r.text).toMatch(/今日配额 \d+%/);
    // Last-429 <details> block.
    expect(r.text).toMatch(/<details class="provider-last-error">/);
    expect(r.text).toMatch(/throttled by upstream/);
  });

  it('renders the auto-re-enable countdown pill when auto_reenable_at is ~5min in the future', async () => {
    // Disable ip-api + set auto_reenable_at ~5 minutes ahead. The pill
    // should render with "5 分钟后自动恢复" (zh-CN i18n).
    const fiveMinFromNow = new Date(Date.now() + 5 * 60_000);
    await updateProviderConfig(td.pool, 'ip-api', {
      enabled: false,
      autoReenableAt: fiveMinFromNow,
      autoDisabledReason: '429 rate limited',
    });

    const r = await request(app.server).get('/admin/unknown-ips?tab=providers').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/\d+ 分钟后自动恢复/);
  });

  it('does NOT render the auto-re-enable pill when provider is enabled', async () => {
    // auto_reenable_at is set but the provider is enabled — no countdown
    // should show (template guards on !enabled).
    const fiveMinFromNow = new Date(Date.now() + 5 * 60_000);
    await updateProviderConfig(td.pool, 'ip-api', {
      enabled: true,
      autoReenableAt: fiveMinFromNow,
    });
    const r = await request(app.server).get('/admin/unknown-ips?tab=providers').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/分钟后自动恢复/);
  });

  it('does NOT render the last-429 details block when no 429 rows exist', async () => {
    // No seeded 429 — <details> should be absent.
    await td.pool.query(
      `INSERT INTO provider_call_counter
         (provider_name, day_utc, calls_total, calls_429, calls_timeout,
          calls_network_err, calls_other_err, last_called_at)
       VALUES ('ip-api', CURDATE(), 50, 0, 0, 0, 0, NOW(3))`,
    );
    const r = await request(app.server).get('/admin/unknown-ips?tab=providers').set('Cookie', 'sid=' + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/<details class="provider-last-error">/);
  });
});
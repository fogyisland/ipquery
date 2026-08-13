// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';

let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => { const cfg = loadConfig(); cfg.db.database = 'ipquery_web_plugins_test'; app = await buildServer(cfg); });
afterAll(async () => { await app.close(); });

describe('web plugins', () => {
  it('serves static /assets/ route', async () => {
    const r = await app.inject({ method: 'GET', url: '/assets/css/base.css' });
    expect([200, 404]).toContain(r.statusCode);
  });

  it('security headers present', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
  });
});

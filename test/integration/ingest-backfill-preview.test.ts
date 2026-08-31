// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import { createUser } from '../../src/storage/users';
import { createSession } from '../../src/storage/sessions';
import { generateToken } from '../../src/web/auth/tokens';
import { insertOrIncrement } from '../../src/storage/unknownIpQueue';
import { parseIp } from '../../src/ip';
import type { IpGeoProvider, IpGeoRecord, IpGeoLookupResult } from '../../src/etl/providers/types';
import { setSetting } from '../../src/storage/settings';

// ── Provider stubs ────────────────────────────────────────────────────
// We override buildProvidersFromConfig() so the route uses our stubs.
// Using real seeded catalog names (ip-api / ipinfo / ...) keeps the
// circuit-breaker + auto-disable code paths exercised without spinning up
// real HTTP servers.

function rec(over: Partial<IpGeoRecord>): IpGeoRecord {
  return {
    countryCode: null, countryName: null, region: null, city: null,
    latitude: null, longitude: null, timezone: null, isp: null, asn: null, asnOrg: null,
    ...over,
  };
}

class StubProvider implements IpGeoProvider {
  readonly name: string;
  responses: Map<string, IpGeoRecord | null>;
  callCount = 0;
  constructor(name: string, responses: Record<string, IpGeoRecord | null> = {}) {
    this.name = name;
    this.responses = new Map(Object.entries(responses));
  }
  async lookup(ip: string): Promise<IpGeoLookupResult> {
    this.callCount += 1;
    return { record: this.responses.get(ip) ?? null, rateLimited: false };
  }
}

// Module-level list — the test sets it before each test, buildServer
// is called once in beforeAll. Stubs are looked up by name in
// buildProvidersFromConfig via the registry pattern below.
const testStubs: Record<string, StubProvider> = {};

vi.mock('../../src/storage/ingestProviders', async () => {
  // Re-export everything from the real module but replace
  // buildProvidersFromConfig with a stub-friendly variant.
  // MUST stay sync — the real export is sync; making it async would
  // make the route assign a Promise<Array> to `providers`, which then
  // fails `providers.map is not a function`.
  const real = await vi.importActual<typeof import('../../src/storage/ingestProviders')>('../../src/storage/ingestProviders');
  return {
    ...real,
    buildProvidersFromConfig: () => {
      return Object.values(testStubs);
    },
  };
});

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
const HMAC_KEY = 'dev-fallback-backfill-preview';

beforeAll(async () => {
  // Force SESSION_SECRET to a known value so the test's tampered-cookie
  // case can sign against a stable key. (The HMAC helper falls back to
  // the literal 'dev-fallback-backfill-preview' when neither
  // SESSION_SECRET nor CSRF_SECRET is set, which we already match.)
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || HMAC_KEY;

  td = await createTestDb('ingestBackfillPreview');
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: 'a@x.com', passwordHash: 'h', displayName: 'A', role: 'admin',
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});

afterAll(async () => { await app.close(); await dropTestDb(td); });

beforeEach(async () => {
  // Register 3 agreeing providers so the preview will produce a
  // consensus-merged row for every queued IP.
  const responses: Record<string, IpGeoRecord | null> = {};
  for (let i = 10; i < 20; i++) responses[`203.0.113.${i}`] = rec({ countryCode: 'US', city: 'MV', asn: 15169 });
  testStubs.ipapi = new StubProvider('ipapi', responses);
  testStubs.ipinfo = new StubProvider('ipinfo', responses);
  testStubs.iplocate = new StubProvider('iplocate', responses);
  await td.pool.query('TRUNCATE TABLE unknown_ip_queue');
  await td.pool.query('TRUNCATE TABLE ip_ranges');
  // Disable circuit breaker so provider failures don't interfere.
  await setSetting(app.pool, 'cb_enabled', '0');
});

async function queueThreeIps(): Promise<string[]> {
  const ips = ['203.0.113.10', '203.0.113.11', '203.0.113.12'];
  for (const ip of ips) {
    await insertOrIncrement(td.pool, parseIp(ip)!, ip);
  }
  return ips;
}

/** Extract a cookie from a Set-Cookie header by name. */
function cookieFromSetCookie(setCookie: string | string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  const raw = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie;
  for (const line of raw.split('\n')) {
    const m = line.match(new RegExp('^' + name + '=([^;]+)'));
    if (m) return decodeURIComponent(m[1]!);
  }
  return null;
}

/** Pull a named cookie out of a supertest agent's cookie jar.
 *  The agent's jar (cookiejar.CookieJar) stores cookies as
 *  { name, value, ... } objects accessible via getCookies(). */
function jarCookie(agent: ReturnType<typeof request.agent>, name: string): string | null {
  // Access the internal cookiejar — pass CookieAccessInfo.All to bypass
  // path/domain matching.
  const CookieAccessInfo = require('cookiejar').CookieAccessInfo;
  const cookies = (agent as unknown as { jar: { getCookies: (info: unknown) => Array<{ name: string; value: string }> } })
    .jar.getCookies(CookieAccessInfo.All);
  for (const c of cookies) {
    if (c.name === name) return decodeURIComponent(c.value);
  }
  return null;
}

/** Force-seed the agent's jar with `sid` so the auth middleware treats
 *  the agent as logged in as the admin. Without this every request is
 *  403'd by /admin/* auth guard. */
function loginAgent(agent: ReturnType<typeof request.agent>): void {
  // Use the cookiejar API to insert the sid cookie directly. We can't
  // rely on the server-set sid because no /login call happens in this
  // test — we mint the sid in beforeAll.
  const jar = (agent as unknown as { jar: { setCookies: (cookies: string, domain: string, path: string) => unknown[] } }).jar;
  jar.setCookies(`sid=${adminSid}`, '127.0.0.1', '/');
}

describe('GET /admin/ingest/backfill/preview — missing cookie', () => {
  it('redirects to /admin/ingest when no preview cookie is present', async () => {
    const r = await request(app.server)
      .get('/admin/ingest/backfill/preview')
      .set('Cookie', `sid=${adminSid}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/admin/ingest');
    // The flash cookie is set to kind=preview_missing.
    const flash = cookieFromSetCookie(r.headers['set-cookie'], 'backfill_summary');
    expect(flash).not.toBeNull();
    const parsed = JSON.parse(flash!);
    expect(parsed.kind).toBe('preview_missing');
  });
});

describe('POST /admin/ingest/backfill/preview — dry-run, no writes', () => {
  it('runs providers in dry-run, does NOT insert into ip_ranges, sets backfill_preview cookie, returns 302', async () => {
    await queueThreeIps();
    const agent = request.agent(app.server);
    await loginAgent(agent);
    // Force a csrf cookie to be issued.
    await agent.get('/admin/ingest');
    const csrf = jarCookie(agent, 'csrf');
    console.log('[debug] jar csrf', csrf);
    expect(csrf).not.toBeNull();

    const r2 = await agent
      .post('/admin/ingest/backfill/preview')
      .type('form')
      .send({ csrf, batchLimit: '3' });
    console.log('[debug] r2 status', r2.status, 'body', r2.text?.slice(0, 200));
    expect(r2.status).toBe(302);
    expect(r2.headers.location).toBe('/admin/ingest/backfill/preview');

    // backfill_preview cookie was set.
    const previewCookie = cookieFromSetCookie(r2.headers['set-cookie'], 'backfill_preview');
    expect(previewCookie).not.toBeNull();

    // KEY: no INSERT into ip_ranges happened.
    const [rows] = await td.pool.query<{ id: number }[]>(`SELECT id FROM ip_ranges`);
    expect(rows.length).toBe(0);

    // And the queue rows are still pending (dryRun skips markProcessed).
    const [q] = await td.pool.query<{ processed_at: Date | null }[]>(
      `SELECT processed_at FROM unknown_ip_queue LIMIT 1`,
    );
    expect(q[0].processed_at).toBeNull();
  });
});

describe('GET /admin/ingest/backfill/preview — renders preview table', () => {
  it('renders the preview table with one row per considered IP and the consensus country', async () => {
    await queueThreeIps();
    const agent = request.agent(app.server);
    await loginAgent(agent);
    await agent.get('/admin/ingest');
    const csrf = jarCookie(agent, 'csrf')!;

    const previewResp = await agent
      .post('/admin/ingest/backfill/preview')
      .type('form')
      .send({ csrf, batchLimit: '3' });
    expect(previewResp.status).toBe(302);
    const previewCookie = cookieFromSetCookie(previewResp.headers['set-cookie'], 'backfill_preview')!;

    // GET preview with the cookie + sid.
    const r = await agent.get('/admin/ingest/backfill/preview');
    expect(r.status).toBe(200);
    // Page title and key copy render.
    expect(r.text).toMatch(/回填预览|Backfill preview/);
    // All three IPs render.
    expect(r.text).toMatch(/203\.0\.113\.10/);
    expect(r.text).toMatch(/203\.0\.113\.11/);
    expect(r.text).toMatch(/203\.0\.113\.12/);
    // Consensus country badge renders.
    expect(r.text).toMatch(/US/);
    // Outcome badge for a merged IP renders.
    expect(r.text).toMatch(/admin-tag--ok/);
    // The asset script is wired in.
    expect(r.text).toMatch(/\/assets\/backfill-preview\.js/);
  });
});

describe('POST /admin/ingest/backfill/confirm — token-verified write', () => {
  it('writes ip_ranges, clears preview cookie, sets backfill_summary flash, returns 302', async () => {
    await queueThreeIps();
    const agent = request.agent(app.server);
    await loginAgent(agent);
    await agent.get('/admin/ingest');
    const csrf = jarCookie(agent, 'csrf')!;

    const previewResp = await agent
      .post('/admin/ingest/backfill/preview')
      .type('form')
      .send({ csrf, batchLimit: '3' });
    expect(previewResp.status).toBe(302);
    const previewCookie = cookieFromSetCookie(previewResp.headers['set-cookie'], 'backfill_preview')!;

    // Decode the cookie to extract the matching token (server-issued).
    const env = JSON.parse(Buffer.from(previewCookie, 'base64url').toString('utf8'));
    const payload = JSON.parse(env.p);
    const token = payload.token;

    const confirmResp = await agent
      .post('/admin/ingest/backfill/confirm')
      .type('form')
      .send({ csrf, token, batchLimit: '3' });
    expect(confirmResp.status).toBe(302);
    expect(confirmResp.headers.location).toBe('/admin/ingest#overview');

    // KEY: ip_ranges now has rows.
    const [rows] = await td.pool.query<{ country_code: string }[]>(`SELECT country_code FROM ip_ranges`);
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.country_code).toBe('US');

    // backfill_summary flash cookie was set.
    const summaryCookie = cookieFromSetCookie(confirmResp.headers['set-cookie'], 'backfill_summary');
    expect(summaryCookie).not.toBeNull();
    const summary = JSON.parse(summaryCookie!);
    expect(summary.merged).toBe(3);

    // backfill_preview cookie was CLEARED.
    const clearCookie = (confirmResp.headers['set-cookie'] as string[] | string | undefined);
    const clearRaw = Array.isArray(clearCookie) ? clearCookie.join('\n') : (clearCookie ?? '');
    expect(clearRaw).toMatch(/backfill_preview=/);
    // Fastify clears by emitting `backfill_preview=;` with an Expires in
    // the past and Max-Age=0. Match either, with the clear directive and
    // an empty value (cookie value wiped).
    expect(clearRaw).toMatch(/backfill_preview=;/);
    expect(clearRaw).toMatch(/Expires=Thu,\s*01\s+Jan\s+1970|Max-Age=0/i);
  });

  it('redirects back to /admin/ingest when cookie is tampered (one byte flipped)', async () => {
    await queueThreeIps();
    const agent = request.agent(app.server);
    await loginAgent(agent);
    await agent.get('/admin/ingest');
    const csrf = jarCookie(agent, 'csrf')!;

    const previewResp = await agent
      .post('/admin/ingest/backfill/preview')
      .type('form')
      .send({ csrf, batchLimit: '3' });
    expect(previewResp.status).toBe(302);
    const previewCookie = cookieFromSetCookie(previewResp.headers['set-cookie'], 'backfill_preview')!;
    const env = JSON.parse(Buffer.from(previewCookie, 'base64url').toString('utf8'));
    const payload = JSON.parse(env.p);
    // Tamper: flip the last character of the signature.
    const tampered = previewCookie.slice(0, -1) + (previewCookie.slice(-1) === 'A' ? 'B' : 'A');

    // Use a NEW agent (so we don't carry the legitimate preview cookie
    // through the request jar) and explicitly inject the tampered cookie.
    const agent2 = request.agent(app.server);
    await loginAgent(agent2);
    await agent2.get('/admin/ingest');
    const csrf2 = jarCookie(agent2, 'csrf')!;

    const r = await agent2
      .post('/admin/ingest/backfill/confirm')
      .set('Cookie', `backfill_preview=${tampered}`)
      .type('form')
      .send({ csrf: csrf2, token: payload.token, batchLimit: '3' });
    // Either 403 (server chose to surface a 403 on tamper) or 302 — the
    // important thing is no writes happened.
    expect([302, 403]).toContain(r.status);
    if (r.status === 302) expect(r.headers.location).toBe('/admin/ingest');

    // No writes.
    const [rows] = await td.pool.query<{ id: number }[]>(`SELECT id FROM ip_ranges`);
    expect(rows.length).toBe(0);
  });

  it('expires the cookie after 60s — confirm with an expired cookie redirects to /admin/ingest', async () => {
    await queueThreeIps();
    const agent = request.agent(app.server);
    await loginAgent(agent);
    await agent.get('/admin/ingest');
    const csrf = jarCookie(agent, 'csrf')!;

    const previewResp = await agent
      .post('/admin/ingest/backfill/preview')
      .type('form')
      .send({ csrf, batchLimit: '3' });
    expect(previewResp.status).toBe(302);
    const previewCookie = cookieFromSetCookie(previewResp.headers['set-cookie'], 'backfill_preview')!;
    const env = JSON.parse(Buffer.from(previewCookie, 'base64url').toString('utf8'));
    const payload = JSON.parse(env.p);
    const token = payload.token;

    // Mutate the payload's runAt to simulate 61s of age, then re-sign
    // with the dev HMAC key so the cookie passes the signature check
    // but the age check fails.
    const expiredPayload = { ...payload, runAt: Date.now() - 61_000 };
    const json = JSON.stringify(expiredPayload);
    const sig = require('node:crypto').createHmac('sha256', HMAC_KEY).update(json).digest('hex');
    const expiredCookie = Buffer.from(JSON.stringify({ p: json, s: sig })).toString('base64url');

    // Use a fresh agent so the legit preview cookie doesn't get reused.
    const agent2 = request.agent(app.server);
    await loginAgent(agent2);
    await agent2.get('/admin/ingest');
    const csrf2 = jarCookie(agent2, 'csrf')!;

    const r = await agent2
      .post('/admin/ingest/backfill/confirm')
      .set('Cookie', `backfill_preview=${expiredCookie}`)
      .type('form')
      .send({ csrf: csrf2, token, batchLimit: '3' });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/admin/ingest');

    // No writes happened.
    const [rows] = await td.pool.query<{ id: number }[]>(`SELECT id FROM ip_ranges`);
    expect(rows.length).toBe(0);
  });
});

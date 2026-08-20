// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as mysql from 'mysql2/promise';
import { loadConfig } from '../../src/config';
import { runMigrations } from '../../src/storage/migrations/runner';
import { buildServer } from '../../src/api/server';
import { getSetting, isInitialized, markInitialized } from '../../src/storage/settings';

const TEST_DB = 'ipquery_test_setup_routes';

let td: { pool: mysql.Pool; dbName: string };
let appPre: Awaited<ReturnType<typeof buildServer>>;
let appPost: Awaited<ReturnType<typeof buildServer>>;

async function dropAndCreate(): Promise<{ pool: mysql.Pool; dbName: string }> {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.query(`CREATE DATABASE \`${TEST_DB}\``);
  await root.end();
  const pool = mysql.createPool({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
    database: TEST_DB, connectionLimit: 2, multipleStatements: true, timezone: 'Z', dateStrings: false,
  });
  await runMigrations(pool);
  // Intentionally do NOT call markInitialized here — we want to test the
  // uninitialized path. The setupGuard's boot cache should read the missing
  // `initialized_at` row and flip `requireSetup=true`.
  return { pool, dbName: TEST_DB };
}

async function dropDb(dbName: string): Promise<void> {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await root.end();
}

// Helper: extract the csrf token from a rendered HBS page. The form templates
// render `<input type="hidden" name="csrf" value="...">` exactly once per page.
function extractCsrf(html: string): string {
  const m = /<input[^>]+name="csrf"[^>]+value="([^"]+)"/.exec(html);
  if (!m) throw new Error('csrf hidden input not found in page');
  return m[1]!;
}

beforeAll(async () => {
  td = await dropAndCreate();
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  appPre = await buildServer(cfg);
});

afterAll(async () => {
  await appPre.close();
  if (appPost) await appPost.close();
  await td.pool.end();
  await dropDb(td.dbName);
});

describe('setup wizard routes', () => {
  it('GET /setup returns 200 with the welcome page', async () => {
    const r = await request(appPre.server).get('/setup');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Welcome');
  });

  it('GET / redirects to /setup when uninitialized', async () => {
    const r = await request(appPre.server).get('/');
    expect(r.status).toBe(302);
    expect(r.headers['location']).toBe('/setup');
  });

  it('GET /setup/admin returns 200 with the form', async () => {
    const r = await request(appPre.server).get('/setup/admin');
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="email"');
    expect(r.text).toContain('name="password"');
    expect(r.text).toContain('name="csrf"');
  });

  it('POST /setup/database with valid CSRF redirects to /setup/site', async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get('/setup/database');
    const csrf = extractCsrf(page.text);
    const r = await agent.post('/setup/database').type('form').send({ csrf });
    expect(r.status).toBe(302);
    expect(r.headers['location']).toMatch(/^\/setup\/site/);
  });

  it('POST /setup/site with valid CSRF saves settings and redirects to /setup/admin', async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get('/setup/site');
    const csrf = extractCsrf(page.text);
    const r = await agent.post('/setup/site').type('form').send({
      csrf, name: 'Test Site', tagline: 'hello',
    });
    expect(r.status).toBe(302);
    expect(r.headers['location']).toMatch(/^\/setup\/admin/);
    expect(await getSetting(td.pool, 'site.name')).toBe('Test Site');
    expect(await getSetting(td.pool, 'site.tagline')).toBe('hello');
  });

  it('POST /setup/admin with valid credentials creates admin and redirects to /setup/seed', async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get('/setup/admin');
    const csrf = extractCsrf(page.text);
    const r = await agent.post('/setup/admin').type('form').send({
      csrf, email: 'admin@setup.test', password: 'longpassword1', displayName: 'Setup Admin',
    });
    expect(r.status).toBe(302);
    expect(r.headers['location']).toMatch(/^\/setup\/seed/);

    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT email, role FROM users WHERE email = ?`,
      ['admin@setup.test'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe('admin');
  });

  it('POST /setup/admin with weak password redirects back with no user created', async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get('/setup/admin');
    const csrf = extractCsrf(page.text);
    const r = await agent.post('/setup/admin').type('form').send({
      csrf, email: 'weak@setup.test', password: 'short', displayName: 'Weak',
    });
    expect(r.status).toBe(302);
    expect(r.headers['location']).toMatch(/^\/setup\/admin/);

    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT id FROM users WHERE email = ?`,
      ['weak@setup.test'],
    );
    expect(rows.length).toBe(0);
  });

  it('POST /setup/seed with load=true runs migrations and ensures 50 seed rows, redirects to /setup/complete', async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get('/setup/seed');
    const csrf = extractCsrf(page.text);
    const r = await agent.post('/setup/seed').type('form').send({ csrf, load: 'true' });
    expect(r.status).toBe(302);
    expect(r.headers['location']).toMatch(/^\/setup\/complete/);

    const [seedRows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'`,
    );
    expect(Number(seedRows[0]!.n)).toBe(50);
    expect(await getSetting(td.pool, 'seed.loaded')).toBe('true');
  });

  it('POST /setup/seed with load=false is idempotent (migrations still run) and leaves 0 seed rows', async () => {
    // First wipe the seed rows so we can verify load=false inserts none.
    await td.pool.query(`DELETE FROM ip_ranges WHERE country_source = 'seed'`);
    const agent = request.agent(appPre.server);
    const page = await agent.get('/setup/seed');
    const csrf = extractCsrf(page.text);
    const r = await agent.post('/setup/seed').type('form').send({ csrf, load: 'false' });
    expect(r.status).toBe(302);
    expect(r.headers['location']).toMatch(/^\/setup\/complete/);

    const [seedRows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'`,
    );
    // load=false does not insert; the migration runner is still idempotent.
    expect(Number(seedRows[0]!.n)).toBe(0);
    expect(await getSetting(td.pool, 'seed.loaded')).toBe('false');
  });

  it('POST /setup/complete marks initialized, redirects to /login, and locks /setup out', async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get('/setup/complete');
    const csrf = extractCsrf(page.text);
    const r = await agent.post('/setup/complete').type('form').send({ csrf });
    expect(r.status).toBe(302);
    expect(r.headers['location']).toMatch(/^\/login/);
    expect(await isInitialized(td.pool)).toBe(true);

    // Rebuild server to refresh boot cache; setupGuard now reads initialized_at
    // and should flip requireSetup=false. /setup is locked out (404) and /
    // no longer redirects.
    const cfg = loadConfig(); cfg.db.database = td.dbName;
    appPost = await buildServer(cfg);

    const root = await request(appPost.server).get('/');
    expect(root.status).not.toBe(302);

    const setup = await request(appPost.server).get('/setup');
    expect(setup.status).toBe(404);
  });
});

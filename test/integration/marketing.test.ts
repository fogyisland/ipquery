// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/api/server';
import request from 'supertest';

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  td = await createTestDb('marketing');
  const cfg = loadConfig(); cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => { await app.close(); await dropTestDb(td); });

describe('marketing routes', () => {
  it('GET / returns 200', async () => {
    const r = await request(app.server).get('/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('IPQuery');
  });
  it('GET /about returns 200', async () => {
    const r = await request(app.server).get('/about');
    expect(r.status).toBe(200);
    expect(r.text).toContain('IPQuery');
  });
  it('GET /docs returns 200', async () => {
    const r = await request(app.server).get('/docs');
    expect(r.status).toBe(200);
    expect(r.text).toContain('/lookup');
  });
  it('GET /pricing returns 404 (route removed in Task 14)', async () => {
    const r = await request(app.server).get('/pricing');
    expect(r.status).toBe(404);
  });
  it('GET /status returns 200', async () => {
    const r = await request(app.server).get('/status');
    expect(r.status).toBe(200);
    expect(r.text).toContain('ETL');
  });
});

// Render-regression tests for the r2 redesign. Each test pins a structural
// feature that, if accidentally deleted in a future refactor, would silently
// degrade the page without any test failing today.
describe('marketing render — r2 redesign', () => {
  it('home renders the bit-anatomy signature (4 byte rows)', async () => {
    const r = await request(app.server).get('/');
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/<div class="m-bits-row">[\s\S]*?byte 1[\s\S]*?byte 2[\s\S]*?byte 3[\s\S]*?byte 4/);
    // 4 cells lit per byte × 4 bytes = 16 lit cells
    const litCount = (r.text.match(/m-bits-cell--on/g) ?? []).length;
    expect(litCount).toBe(16);
  });

  it('about nav link is marked active when on /about', async () => {
    // The nav has no "Home" entry (the brand mark is the home link); the
    // .active class lights up docs/try/status/about. Verify the route flag
    // actually drives it.
    const r = await request(app.server).get('/about');
    expect(r.status).toBe(200);
    // The about link should have class="active" inside m-topnav-links
    expect(r.text).toMatch(/m-topnav-links[\s\S]*?class="active"[^>]*>[^<]+<\/a>/);
    // And docs/try/status should NOT be active on /about
    expect(r.text).not.toMatch(/href="\/docs"[^>]*class="active"/);
    expect(r.text).not.toMatch(/href="\/try"[^>]*class="active"/);
    expect(r.text).not.toMatch(/href="\/status"[^>]*class="active"/);
  });

  it('about page renders the 3-entry timeline', async () => {
    const r = await request(app.server).get('/about');
    expect(r.status).toBe(200);
    const years = (r.text.match(/m-timeline-year/g) ?? []).length;
    expect(years).toBe(3);
    expect(r.text).toContain('2024');
    expect(r.text).toContain('2025');
    expect(r.text).toContain('2026');
  });

  it('docs page renders sidebar TOC + 4 endpoint cards', async () => {
    const r = await request(app.server).get('/docs');
    expect(r.status).toBe(200);
    expect(r.text).toContain('m-docs-toc');
    const endpoints = (r.text.match(/class="m-endpoint"/g) ?? []).length;
    expect(endpoints).toBe(4);
    // Each anchor link target must exist in the doc
    expect(r.text).toContain('id="endpoints"');
    expect(r.text).toContain('id="examples"');
    expect(r.text).toContain('id="auth"');
    expect(r.text).toContain('id="response"');
    expect(r.text).toContain('id="errors"');
  });

  it('try page renders the chip set + query form', async () => {
    const r = await request(app.server).get('/try');
    expect(r.status).toBe(200);
    expect(r.text).toContain('m-try-form');
    expect(r.text).toContain('data-ip="8.8.8.8"');
    expect(r.text).toContain('data-ip="1.1.1.1"');
    expect(r.text).toContain('data-ip="114.114.114.114"');
    expect(r.text).toContain('data-ip="9.9.9.9"');
  });

  it('status page renders live banner + services + empty-state when no runs', async () => {
    const r = await request(app.server).get('/status');
    expect(r.status).toBe(200);
    // Banner + 3 service rows always render
    expect(r.text).toContain('m-status-banner');
    expect(r.text).toContain('m-status-services');
    const services = (r.text.match(/class="m-status-service"/g) ?? []).length;
    expect(services).toBe(3);
    // No ETL rows in a fresh test DB → empty-state alert renders.
    // Match either locale so the test passes regardless of default req locale.
    expect(r.text).toMatch(/No ETL runs yet|暂无 ETL 运行记录/);
  });

  it('marketing layout exposes focus-visible outline for keyboard users', async () => {
    // CSS is served at /assets/style.css; just assert the rule is present
    // (avoids a fragile inline-style check).
    const css = await request(app.server).get('/assets/style.css');
    expect(css.status).toBe(200);
    expect(css.text).toContain(':focus-visible');
    expect(css.text).toContain('prefers-color-scheme: dark');
  });
});

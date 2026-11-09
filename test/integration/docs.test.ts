// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  td = await createTestDb("docs");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("/docs API reference", () => {
  // Marketing redesign: /docs renders inside layouts/marketing (no sidebar).
  // Content is the same (4 endpoint rows + curl/JS/Python examples + auth).
  it("GET /docs returns 200 with marketing chrome and 4 API endpoint rows", async () => {
    const r = await request(app.server).get("/docs");
    expect(r.status).toBe(200);
    // Marketing chrome
    expect(r.text).not.toMatch(/<aside class="sidebar">/);
    expect(r.text).toMatch(/class="m-topnav"/);
    // 4 API endpoints: /lookup, /lookup/:ip, /stats, /healthz
    expect(r.text).toContain("/lookup?ip=");
    expect(r.text).toContain("/lookup/");
    expect(r.text).toContain("/stats");
    expect(r.text).toContain("/healthz");
    // At least one curl example block
    expect(r.text).toMatch(/data-pane="curl"/);
  });

  it("GET /docs documents the rate limits and quotes the server's own limit", async () => {
    // The locale comes from the `lang` cookie (default zh-CN), so the
    // test pins it explicitly rather than depending on the default.
    const r = await request(app.server).get("/docs").set("cookie", "lang=en-US");
    expect(r.status).toBe(200);
    // The rate-limits section and its table-of-contents entry.
    expect(r.text).toContain('id="ratelimits"');
    expect(r.text).toContain('href="#ratelimits"');
    // The three scopes.
    expect(r.text).toContain("Anonymous");
    expect(r.text).toContain("API key");
    expect(r.text).toContain("Admin panel");
    // The number comes from the server's config, not a hardcoded string —
    // the default is 60/min, and the test config leaves it there.
    expect(r.text).toContain("<code>60/min</code>");
    // The note about route-level limits replacing rather than stacking.
    expect(r.text).toContain("replaces the global limit");
  });

  it("GET /docs renders the rate-limits section in zh-CN too", async () => {
    const r = await request(app.server).get("/docs").set("cookie", "lang=zh-CN");
    expect(r.status).toBe(200);
    expect(r.text).toContain('id="ratelimits"');
    expect(r.text).toContain("匿名请求");
    expect(r.text).toContain("管理后台");
  });
});

// SPDX-License-Identifier: MIT
//
// PR2 — Strategy-Pattern UI refactor: /admin/unknown-ips → /admin/ingest
// (Strategy Execution) and /admin/providers/* (Strategy Definition).
// These tests cover the moved routes + the 302 back-compat redirects.
//
// Test patterns mirror providers-page.test.ts / auto-reenable-route.test.ts.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { updateProviderConfig } from "../../src/storage/ingestProviders";
import {
  setCircuitBreakerConfig as _setCircuitBreakerConfig,
  getCircuitBreakerConfig,
} from "../../src/storage/providerErrorLog";
import { _resetProviderHealthCache } from "../../src/storage/providerErrorLog";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]),
}));

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("ingest-rename");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "a@x.com",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

beforeEach(async () => {
  _resetProviderHealthCache();
  await td.pool.query("TRUNCATE TABLE provider_call_counter");
  await td.pool.query("DELETE FROM ingest_providers WHERE is_custom = 1");
  // Reset built-in providers so toggle tests don't leak state.
  for (const name of ["ip-api", "ipinfo", "iplocate", "freeipapi", "ipapi-co"]) {
    await updateProviderConfig(td.pool, name, {
      enabled: true,
      autoReenableAt: null,
      autoDisabledReason: null,
    });
  }
});

/** GET the new ingest page so the CSRF cookies are seeded, then return
 *  the (cookie, token) pair needed by the matching POST. Mirrors the
 *  csrfPair() pattern in auto-reenable-route.test.ts. */
async function csrfPair(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server)
    .get("/admin/ingest")
    .set("Cookie", "sid=" + adminSid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
  const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
  const bindLine = cookies.find((c) => c.startsWith("csrf_bind="))!.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}; ${bindLine}`, token: tokenMatch[1]! };
}

describe("GET /admin/ingest (Strategy Execution surface)", () => {
  it("returns 200 with the two-tab ingest console", async () => {
    const r = await request(app.server)
      .get("/admin/ingest")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    // Page title from admin.unknownIps.title (zh-CN default: "API 入库").
    expect(r.text).toMatch(/API 入库/);
    // Tab-nav still has Overview + Failure Logs (providers tab removed).
    expect(r.text).toMatch(/data-tab="overview"/);
    expect(r.text).toMatch(/data-tab="failure-logs"/);
    expect(r.text).not.toMatch(/data-tab="providers"/);
    // Form actions all live under /admin/ingest/* now.
    expect(r.text).toMatch(/action="\/admin\/ingest\/generate"/);
    expect(r.text).toMatch(/action="\/admin\/ingest\/queue\/clear"/);
    expect(r.text).toMatch(/action="\/admin\/ingest\/scheduler"/);
  });
});

describe("POST /admin/ingest/queue/clear", () => {
  it("clears the pending queue and redirects back to /admin/ingest#overview", async () => {
    const { cookie, token } = await csrfPair();
    const r = await request(app.server)
      .post("/admin/ingest/queue/clear")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/\/admin\/ingest(#overview)?$/);
  });
});

describe("POST /admin/providers/:name (manual toggle)", () => {
  it("disables ip-api and 302s back to /admin/providers", async () => {
    const { cookie, token } = await csrfPair();
    const r = await request(app.server)
      .post("/admin/providers/ip-api")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, enabled: "off", apiKey: "" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/\/admin\/providers/);
  });
});

describe("POST /admin/providers/circuit-breaker", () => {
  it("saves circuit-breaker settings and redirects to /admin/providers", async () => {
    const { cookie, token } = await csrfPair();
    const r = await request(app.server)
      .post("/admin/providers/circuit-breaker")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, enabled: "on", threshold: "50", window: "10", cooldown: "15" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/\/admin\/providers/);
    // Verify the save persisted to settings (cb_*).
    const cb = await getCircuitBreakerConfig(td.pool);
    expect(cb.enabled).toBe(true);
    expect(cb.failureThresholdPct).toBe(50);
  });
});

describe("Back-compat 302 redirects from /admin/unknown-ips/*", () => {
  it("GET /admin/unknown-ips redirects to /admin/ingest", async () => {
    const r = await request(app.server)
      .get("/admin/unknown-ips")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/admin/ingest");
  });

  it("GET /admin/unknown-ips/providers/custom redirects to /admin/providers#custom", async () => {
    const r = await request(app.server)
      .get("/admin/unknown-ips/providers/custom")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/admin/providers#custom");
  });

  it("POST /admin/unknown-ips/backfill runs the legacy one-step backfill and redirects to /admin/ingest#overview", async () => {
    // PR3 added the preview/confirm flow on /admin/ingest/backfill/*.
    // The legacy /admin/unknown-ips/backfill POST still runs the
    // one-step backfill (no preview) so any cron caller that bypasses
    // the UI keeps working until that caller is updated. The UI itself
    // is preview-first.
    const { cookie, token } = await csrfPair();
    const r = await request(app.server)
      .post("/admin/unknown-ips/backfill")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/admin/ingest#overview");
  });
});

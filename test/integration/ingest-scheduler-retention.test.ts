// SPDX-License-Identifier: MIT
//
// POST /admin/ingest/scheduler — the scheduler config form. This test
// focuses on the probe-retention field: the form writes the retention
// window, the ingest page reads it back, and an absent field leaves
// the stored value untouched.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { loadRetentionDays, DEFAULT_RETENTION_DAYS } from "../../src/storage/randomProbeLog";
import { csrfTripleFrom } from "../helpers/csrf";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("ingest-scheduler");
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
  await td.pool.query("DELETE FROM settings WHERE k = 'random_probe_retention_days'");
});

/** Fetch the CSRF triple from a page that sets the cookies. */
async function csrfPair(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get("/admin/ingest").set("Cookie", `sid=${adminSid}`);
  return csrfTripleFrom(r.headers["set-cookie"] as string[]);
}

describe("POST /admin/ingest/scheduler — probe retention", () => {
  it("defaults to 30 days when no setting exists", async () => {
    expect(await loadRetentionDays(app.pool)).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("persists the retention window from the form", async () => {
    const { cookie, token } = await csrfPair();
    const r = await request(app.server)
      .post("/admin/ingest/scheduler")
      .set("Cookie", `sid=${adminSid}; ${cookie}`)
      .type("form")
      .send({ csrf: token, intervalSec: "60", batchSize: "10", retentionDays: "14" });
    expect(r.status).toBe(302);
    expect(await loadRetentionDays(app.pool)).toBe(14);
  });

  it("accepts 0 as 'keep forever'", async () => {
    const { cookie, token } = await csrfPair();
    const r = await request(app.server)
      .post("/admin/ingest/scheduler")
      .set("Cookie", `sid=${adminSid}; ${cookie}`)
      .type("form")
      .send({ csrf: token, intervalSec: "60", batchSize: "10", retentionDays: "0" });
    expect(r.status).toBe(302);
    expect(await loadRetentionDays(app.pool)).toBe(0);
  });

  it("clamps an out-of-range value into 0..3650", async () => {
    const { cookie, token } = await csrfPair();
    await request(app.server)
      .post("/admin/ingest/scheduler")
      .set("Cookie", `sid=${adminSid}; ${cookie}`)
      .type("form")
      .send({ csrf: token, intervalSec: "60", batchSize: "10", retentionDays: "99999" });
    expect(await loadRetentionDays(app.pool)).toBe(3650);

    const pair2 = await csrfPair();
    await request(app.server)
      .post("/admin/ingest/scheduler")
      .set("Cookie", `sid=${adminSid}; ${pair2.cookie}`)
      .type("form")
      .send({ csrf: pair2.token, intervalSec: "60", batchSize: "10", retentionDays: "-5" });
    expect(await loadRetentionDays(app.pool)).toBe(0);
  });

  it("leaves the stored value untouched when the field is absent", async () => {
    // Seed a known value first.
    const { cookie, token } = await csrfPair();
    await request(app.server)
      .post("/admin/ingest/scheduler")
      .set("Cookie", `sid=${adminSid}; ${cookie}`)
      .type("form")
      .send({ csrf: token, intervalSec: "60", batchSize: "10", retentionDays: "21" });
    expect(await loadRetentionDays(app.pool)).toBe(21);

    // Now post without the field at all — it must NOT reset to 0.
    const pair2 = await csrfPair();
    await request(app.server)
      .post("/admin/ingest/scheduler")
      .set("Cookie", `sid=${adminSid}; ${pair2.cookie}`)
      .type("form")
      .send({ csrf: pair2.token, intervalSec: "60", batchSize: "10" });
    expect(await loadRetentionDays(app.pool)).toBe(21);
  });

  it("shows the current retention value on the ingest page", async () => {
    const { cookie, token } = await csrfPair();
    await request(app.server)
      .post("/admin/ingest/scheduler")
      .set("Cookie", `sid=${adminSid}; ${cookie}`)
      .type("form")
      .send({ csrf: token, intervalSec: "60", batchSize: "10", retentionDays: "45" });

    const page = await request(app.server).get("/admin/ingest").set("Cookie", `sid=${adminSid}`);
    expect(page.status).toBe(200);
    // The form input carries the current value.
    expect(page.text).toMatch(/name="retentionDays"[^>]*value="45"/);
  });

  it("rejects the POST without a valid CSRF token", async () => {
    const r = await request(app.server)
      .post("/admin/ingest/scheduler")
      .set("Cookie", `sid=${adminSid}`)
      .type("form")
      .send({ intervalSec: "60", batchSize: "10", retentionDays: "7" });
    expect(r.status).toBe(403);
  });
});

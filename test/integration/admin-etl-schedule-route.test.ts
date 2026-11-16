// SPDX-License-Identifier: MIT
// Integration test: an operator can change the ETL cadence from the
// console, and the change is what the scheduler will use.
//
// Before this, the schedule was read-only text on /admin/settings and the
// only way to change it was `ETL_SCHEDULE` in `.env` plus a restart.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as zlib from "node:zlib";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { csrfTripleFrom } from "../helpers/csrf";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { getSetting } from "../../src/storage/settings";
import { loadEtlScheduleConfig } from "../../src/storage/etlSchedule";
import { generateToken } from "../../src/web/auth/tokens";
import * as fs from "node:fs/promises";
import * as path from "node:path";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("admin_etl_schedule");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  // Keep the fixture set off the network: the admin page only reads the
  // schedule, but buildServer arms the scheduler and any manual trigger
  // would otherwise reach GitHub.
  cfg.etl.dataDir = path.join(__dirname, "..", "tmp-schedule-data");
  await fs.mkdir(path.join(cfg.etl.dataDir, "raw"), { recursive: true });
  app = await buildServer(cfg);

  const admin = await createUser(td.pool, {
    email: "sched-admin@test",
    passwordHash: "h",
    displayName: "Sched Admin",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(td.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
  await fs.rm(td.dbName ? path.join(__dirname, "..", "tmp-schedule-data") : "", {
    recursive: true,
    force: true,
  });
});

/** GET /admin/settings as the signed-in admin and return its CSRF triple. */
async function settingsCsrf(): Promise<{ cookie: string; token: string }> {
  const page = await request(app.server).get("/admin/settings").set("Cookie", "sid=" + adminSid);
  expect(page.status).toBe(200);
  // The page carries an inline hidden input too; the cookie triple is what
  // the plugin verifies.
  const pair = csrfTripleFrom(page.headers["set-cookie"] as string[]);
  const domToken = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1];
  return { cookie: `${pair.cookie}; sid=${adminSid}`, token: domToken ?? pair.token };
}

describe("POST /admin/settings/etl-schedule", () => {
  it("saves the schedule and re-arms the scheduler", async () => {
    const { cookie, token } = await settingsCsrf();
    const r = await request(app.server)
      .post("/admin/settings/etl-schedule")
      .set("Cookie", cookie)
      .type("form")
      .send({ csrf: token, schedule: "0 3 * * 0", timezone: "Asia/Shanghai" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("/admin/settings");

    expect(await getSetting(td.pool, "etl_schedule")).toBe("0 3 * * 0");
    expect(await getSetting(td.pool, "etl_timezone")).toBe("Asia/Shanghai");
  });

  it("rejects an invalid cron expression and keeps the previous value", async () => {
    const { cookie, token } = await settingsCsrf();
    // The good value from the previous case is the one that must survive.
    const r = await request(app.server)
      .post("/admin/settings/etl-schedule")
      .set("Cookie", cookie)
      .type("form")
      .send({ csrf: token, schedule: "every monday please", timezone: "UTC" });
    expect(r.status).toBe(302);

    expect(await getSetting(td.pool, "etl_schedule")).toBe("0 3 * * 0");
  });

  it("refuses an unauthenticated save", async () => {
    // The admin guard answers 404 rather than 403 so an anonymous caller
    // cannot tell which admin routes exist (see the other admin tests).
    const before = await getSetting(td.pool, "etl_schedule");
    const r = await request(app.server)
      .post("/admin/settings/etl-schedule")
      .type("form")
      .send({ schedule: "0 2 * * 1", timezone: "UTC" });
    expect(r.status).toBe(404);
    expect(await getSetting(td.pool, "etl_schedule")).toBe(before);
  });

  it("shows the effective schedule, not the env seed, once a value is saved", async () => {
    const cfg = loadConfig();
    const resolved = await loadEtlScheduleConfig(td.pool, {
      schedule: cfg.etl.schedule,
      timezone: cfg.etl.timezone,
    });
    expect(resolved.schedule).toBe("0 3 * * 0");
    expect(resolved.timezone).toBe("Asia/Shanghai");
    expect(resolved.source).toBe("saved");
  });
});

// SPDX-License-Identifier: MIT
//
// The admin ETL page polls two JSON endpoints (`/live` and
// `/progress`) once a second, plus reloads `/admin` and
// `/admin/queries`.
//
// The global rate limit is 60/minute, shared with the public API and
// keyed by source IP. Polling alone would eat most of that budget,
// and once the IP was over the limit EVERY admin page would return
// 429 — including the ETL progress bar, which then freezes while
// htmx keeps hammering.
//
// A route-level `config.rateLimit` object REPLACES the global setting
// and gets its own counter (@fastify/rate-limit's onRoute hook calls
// `store.child(...)` for such routes and does not attach the global
// hook), so the polling routes must not consume the public API's
// budget at all.
//
// These tests pin two things:
//
//  1. The polling routes have their own, larger budget.
//  2. The public API's budget is NOT consumed by admin polling — i.e.
//     hammering `/admin` leaves `/lookup` unaffected.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { recordEtlStart } from "../../src/storage/mysql";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let etlRunId: number;

beforeAll(async () => {
  td = await createTestDb("admin-poll-limit");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  // A small global limit makes the "polling does not consume the
  // public budget" assertion cheap to prove: without the route-level
  // override, 12 admin polls would already blow a 10/minute budget.
  cfg.api.rateLimit = 10;
  app = await buildServer(cfg);

  const admin = await createUser(app.pool, {
    email: "a@x.com",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
  const runId = await recordEtlStart(app.pool);
  etlRunId = runId ?? 1;
}, 180_000);

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("admin polling routes have their own rate-limit budget", () => {
  it("does not consume the global API budget when the admin page polls", async () => {
    // The global limit is 10/minute here. Twenty admin polls would be
    // twice that — if the polling routes shared the global counter,
    // the public /lookup route below would be dead.
    for (let i = 0; i < 20; i++) {
      const res = await request(app.server)
        .get("/admin")
        .set("Cookie", "sid=" + adminSid);
      expect(res.status, `admin poll #${i + 1}`).toBe(200);
    }

    // The public API route still has its full budget left.
    const lookup = await request(app.server).get("/lookup").query({ ip: "8.8.8.8" });
    expect(lookup.status).toBe(200);
  });

  it("serves the ETL live and progress endpoints repeatedly without 429", async () => {
    for (let i = 0; i < 10; i++) {
      const live = await request(app.server)
        .get(`/admin/etl/runs/${etlRunId}/live`)
        .set("Cookie", "sid=" + adminSid);
      expect(live.status, `live poll #${i + 1}`).toBe(200);

      const progress = await request(app.server)
        .get(`/admin/etl/runs/${etlRunId}/progress`)
        .set("Cookie", "sid=" + adminSid);
      expect(progress.status, `progress poll #${i + 1}`).toBe(200);
    }
  });

  it("keeps the global API budget separate from the admin polling budget", async () => {
    // The public API's own limit still applies to the public API —
    // the admin override must not have widened it.
    let limited = 0;
    for (let i = 0; i < 15; i++) {
      const res = await request(app.server).get("/lookup").query({ ip: "8.8.8.8" });
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);

    // And the admin polling routes are still fine afterwards.
    const admin = await request(app.server)
      .get("/admin")
      .set("Cookie", "sid=" + adminSid);
    expect(admin.status).toBe(200);
  });
});

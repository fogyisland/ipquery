// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { RowDataPacket } from "mysql2";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { recordEtlStart } from "../../src/storage/mysql";
import { generateToken } from "../../src/web/auth/tokens";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("admin-etl");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  // server.ts registers adminRoutes as part of the production route set;
  // calling app.register(adminRoutes) again here throws "Root plugin has already booted".
  const admin = await createUser(app.pool, {
    email: "a@x.com",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
  await recordEtlStart(app.pool);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

async function csrfOf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server)
    .get("/admin/etl/runs")
    .set("Cookie", "sid=" + adminSid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
  const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}`, token: tokenMatch[1]! };
}

describe("admin ETL", () => {
  it("GET /admin/etl/runs lists runs", async () => {
    const r = await request(app.server)
      .get("/admin/etl/runs")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("running");
  });

  it("GET /admin/etl/runs/:id shows detail", async () => {
    const [rows] = await app.pool.query<RowDataPacket[]>("SELECT id FROM etl_runs LIMIT 1");
    const id = rows[0]?.id;
    const r = await request(app.server)
      .get("/admin/etl/runs/" + id)
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("ETL Run");
  });

  it("POST /admin/etl/trigger creates a new row", async () => {
    const { cookie, token } = await csrfOf();
    const r = await request(app.server)
      .post("/admin/etl/trigger")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);
    // Pipeline is fire-and-forget. recordEtlStart inserts the new row async,
    // so poll briefly for it to appear (the seeded row from beforeAll + the
    // new trigger row). We intentionally don't wait for completion — that
    // would race the pipeline's recordEtlFinish, which can fail later for
    // unrelated reasons (e.g. missing source tables after atomicSwapRanges).
    let count = 1;
    for (let i = 0; i < 20; i++) {
      await new Promise((rr) => setTimeout(rr, 100));
      const [rows] = await app.pool.query<RowDataPacket[]>("SELECT * FROM etl_runs");
      count = rows.length;
      if (count >= 2) break;
    }
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("non-admin -> 403", async () => {
    const user = await createUser(app.pool, { email: "u@x.com", passwordHash: "h", displayName: "U" });
    const userSid = generateToken(16);
    await createSession(app.pool, userSid, user.id, new Date(Date.now() + 3600_000));
    const r = await request(app.server)
      .get("/admin/etl/runs")
      .set("Cookie", "sid=" + userSid);
    expect(r.status).toBe(403);
  });
});

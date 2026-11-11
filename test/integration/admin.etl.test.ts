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
  const bindLine = cookies.find((c) => c.startsWith("csrf_bind="))!.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}; ${bindLine}`, token: tokenMatch[1]! };
}

/** Number of rows in `etl_runs` — the count the trigger test compares against. */
async function countEtlRuns(): Promise<number> {
  const [rows] = await app.pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM etl_runs");
  return Number(rows[0]!.n);
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
    // The trigger route refuses to start while another run row is still
    // 'running' (see src/etl/runGuard.ts): the seeded row from beforeAll
    // is exactly such a row. Close it out first so this test exercises the
    // trigger's happy path — the refusal path is pinned by
    // test/integration/etl-guards.test.ts.
    await app.pool.query(
      `UPDATE etl_runs SET status = 'failed', finished_at = NOW(3) WHERE status = 'running'`,
    );
    const before = await countEtlRuns();

    const { cookie, token } = await csrfOf();
    const r = await request(app.server)
      .post("/admin/etl/trigger")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);
    // The route inserts the run row up-front (it needs the id for the live
    // detail page) and then hands it to the pipeline, which is
    // fire-and-forget. We intentionally don't wait for completion — that
    // would race the pipeline's recordEtlFinish, which can fail later for
    // unrelated reasons (e.g. missing source tables after atomicSwapRanges).
    let count = before;
    for (let i = 0; i < 20; i++) {
      await new Promise((rr) => setTimeout(rr, 100));
      count = await countEtlRuns();
      if (count > before) break;
    }
    expect(count).toBeGreaterThan(before);
  });

  it("POST /admin/etl/trigger is refused while a run is already running", async () => {
    // A crashed run leaves its row at status='running'. The trigger must
    // refuse instead of starting a second, concurrent ETL.
    const stuckRunId = await recordEtlStart(app.pool);
    const before = await countEtlRuns();
    try {
      const { cookie, token } = await csrfOf();
      const r = await request(app.server)
        .post("/admin/etl/trigger")
        .set("Cookie", "sid=" + adminSid + "; " + cookie)
        .type("form")
        .send({ csrf: token });
      expect(r.status).toBe(302);
      // It redirects to the still-running run instead of creating a new one.
      expect(r.headers.location).toContain(`/admin/etl/runs/${stuckRunId}`);
      expect(await countEtlRuns()).toBe(before);
    } finally {
      await app.pool.query(`UPDATE etl_runs SET status = 'failed', finished_at = NOW(3) WHERE id = ?`, [
        stuckRunId,
      ]);
    }
  });

  it("non-admin -> 404", async () => {
    const user = await createUser(app.pool, { email: "u@x.com", passwordHash: "h", displayName: "U" });
    const userSid = generateToken(16);
    await createSession(app.pool, userSid, user.id, new Date(Date.now() + 3600_000));
    const r = await request(app.server)
      .get("/admin/etl/runs")
      .set("Cookie", "sid=" + userSid);
    // The admin guard answers a non-admin with 404, not 403: a 403 would
    // confirm that /admin/* routes exist (see src/web/plugins/auth.ts).
    expect(r.status).toBe(404);  });
});

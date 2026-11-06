// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { recordAuditLog } from "../../src/storage/auditLog";
import type { Pool, ResultSetHeader } from "mysql2/promise";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let adminUid: number;

async function seedEtlRun(pool: Pool): Promise<void> {
  await pool.query<ResultSetHeader>(
    `INSERT INTO etl_runs (started_at, finished_at, status, merged_records)
     VALUES (NOW(3), NOW(3), 'success', 100)`,
  );
}

beforeAll(async () => {
  td = await createTestDb("admin-dashboard");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "admin@x",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminUid = admin.id;
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, adminUid, new Date(Date.now() + 3600_000));
  await seedEtlRun(td.pool);
  await recordAuditLog(td.pool, {
    actor: { id: adminUid, email: "admin@x" },
    action: "test.action",
    metadata: null,
    ip: "1.1.1.1",
    userAgent: "t",
    statusCode: 200,
  });
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("admin dashboard", () => {
  it("returns 200 with cards, chart, recent activity", async () => {
    const r = await request(app.server)
      .get("/admin")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/class="card-value"/);
    // Empty-state chart emits .chart-empty inside .chart-bars
    expect(r.text).toMatch(/class="chart-bars"/);
    expect(r.text).toMatch(/class="activity-feed"/);
  });

  it("auto-refresh markup uses hx-trigger every 30s", async () => {
    const r = await request(app.server)
      .get("/admin")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/hx-trigger="every 30s"/);
  });

  it("non-admin -> 403", async () => {
    const u = await createUser(app.pool, { email: "u@x", passwordHash: "h", displayName: "U" });
    const userSid = generateToken(16);
    await createSession(app.pool, userSid, u.id, new Date(Date.now() + 3600_000));
    const r = await request(app.server)
      .get("/admin")
      .set("Cookie", "sid=" + userSid);
    expect(r.status).toBe(403);
  });
});

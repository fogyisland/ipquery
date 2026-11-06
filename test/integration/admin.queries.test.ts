// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { insertQueryLogs } from "../../src/storage/queryLog";
import { parseIp } from "../../src/ip";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let userUid: number;

beforeAll(async () => {
  td = await createTestDb("admin-queries");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "admin@x.com",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
  const user = await createUser(app.pool, { email: "u@x.com", passwordHash: "h", displayName: "U" });
  userUid = user.id;
  // Seed 3+ query_log rows with a mix of statuses, IPs, and users.
  await insertQueryLogs(app.pool, [
    {
      ip: parseIp("8.8.8.8")!,
      ipText: "8.8.8.8",
      status: "hit",
      userId: userUid,
      apiKeyId: null,
      sessionId: null,
      remoteAddr: null,
      userAgent: "ua1",
    },
    {
      ip: parseIp("9.9.9.9")!,
      ipText: "9.9.9.9",
      status: "miss",
      userId: userUid,
      apiKeyId: null,
      sessionId: null,
      remoteAddr: null,
      userAgent: "ua2",
    },
    {
      ip: parseIp("8.8.8.8")!,
      ipText: "8.8.8.8",
      status: "hit",
      userId: userUid,
      apiKeyId: null,
      sessionId: null,
      remoteAddr: null,
      userAgent: "ua3",
    },
    {
      ip: parseIp("1.1.1.1")!,
      ipText: "1.1.1.1",
      status: "invalid",
      userId: null,
      apiKeyId: null,
      sessionId: adminSid,
      remoteAddr: null,
      userAgent: "ua4",
    },
  ]);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("admin queries stats page", () => {
  it("renders stats page with seeded query_log", async () => {
    const r = await request(app.server)
      .get("/admin/queries")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    // The seeded IP 8.8.8.8 (2 hits) should appear in the top-Ips table.
    expect(r.text).toContain("8.8.8.8");
    // The seeded user u@x.com should appear in the top-users table.
    expect(r.text).toContain("u@x.com");
  });

  it("CSV export", async () => {
    const r = await request(app.server)
      .get("/admin/queries.csv")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    // BOM byte
    expect(r.text.charCodeAt(0)).toBe(0xfeff);
    // Required columns from brief
    expect(r.text).toMatch(/ip_text/);
    expect(r.text).toMatch(/user_email/);
  });
});

// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { insertQueryLogs } from "../../src/storage/queryLog";
import { createApiKey } from "../../src/storage/apiKeys";
import { parseIp } from "../../src/ip";
import { generateToken, generateApiKey, hashToken } from "../../src/web/auth/tokens";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let userUid: number;

beforeAll(async () => {
  td = await createTestDb("admin-audit");
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
  const user = await createUser(app.pool, { email: "u@x.com", passwordHash: "h", displayName: "U" });
  userUid = user.id;
  // seed some query logs
  const plain = generateApiKey();
  const k = await createApiKey(app.pool, userUid, "k", hashToken(plain), plain.slice(0, 8));
  await insertQueryLogs(app.pool, [
    {
      ip: parseIp("8.8.8.8")!,
      ipText: "8.8.8.8",
      status: "hit",
      userId: userUid,
      apiKeyId: k.id,
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
      sessionId: adminSid,
      remoteAddr: null,
      userAgent: null,
    },
  ]);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("admin audit", () => {
  it("GET /admin/keys lists all", async () => {
    const r = await request(app.server)
      .get("/admin/keys")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("u@x.com");
  });

  it("GET /admin/audit shows logs", async () => {
    const r = await request(app.server)
      .get("/admin/audit")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("8.8.8.8");
  });

  it("filter by userEmail", async () => {
    const r = await request(app.server)
      .get("/admin/audit?userEmail=u@x.com")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("8.8.8.8");
  });

  it("GET /admin/audit.csv streams CSV", async () => {
    const r = await request(app.server)
      .get("/admin/audit.csv")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.text.split("\n")[0]).toContain("id,ts,ip_text");
    expect(r.text).toContain("8.8.8.8");
  });
});

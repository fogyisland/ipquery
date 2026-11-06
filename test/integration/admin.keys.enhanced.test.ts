// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { RowDataPacket } from "mysql2";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken, generateApiKey, hashToken } from "../../src/web/auth/tokens";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let userUid: number;

beforeAll(async () => {
  td = await createTestDb("admin-keys-enhanced");
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
  // Seed two users and three api_keys so filter tests are deterministic.
  const user = await createUser(app.pool, { email: "u@x.com", passwordHash: "h", displayName: "U" });
  userUid = user.id;
  const k1Plain = generateApiKey();
  await app.pool.query<RowDataPacket[]>(
    `INSERT INTO api_keys (user_id, label, key_hash, key_prefix, revoked_at) VALUES (?, ?, ?, ?, ?)`,
    [userUid, "k1", hashToken(k1Plain), k1Plain.slice(0, 8), null],
  );
  const k2Plain = generateApiKey();
  await app.pool.query<RowDataPacket[]>(
    `INSERT INTO api_keys (user_id, label, key_hash, key_prefix, revoked_at) VALUES (?, ?, ?, ?, ?)`,
    [userUid, "k2", hashToken(k2Plain), k2Plain.slice(0, 8), null],
  );
  const k3Plain = generateApiKey();
  await app.pool.query<RowDataPacket[]>(
    `INSERT INTO api_keys (user_id, label, key_hash, key_prefix, revoked_at) VALUES (?, ?, ?, ?, NOW(3))`,
    [userUid, "k3", hashToken(k3Plain), k3Plain.slice(0, 8)],
  );
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("admin keys enhanced", () => {
  it("filters by revoked=no", async () => {
    const r = await request(app.server)
      .get("/admin/keys?revoked=no")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    const bodyStart = r.text.indexOf("<tbody");
    const bodyEnd = r.text.indexOf("</tbody>");
    const tbody = r.text.slice(bodyStart, bodyEnd);
    // Two active keys seeded; revoked row must not appear in tbody. We assert
    // it via label visibility: k1 and k2 should be in the table, k3 should not.
    expect(tbody).toMatch(/k1/);
    expect(tbody).toMatch(/k2/);
    expect(tbody).not.toMatch(/k3/);
  });

  it("sorts by id desc by default", async () => {
    const r = await request(app.server)
      .get("/admin/keys")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    const bodyStart = r.text.indexOf("<tbody");
    const bodyEnd = r.text.indexOf("</tbody>");
    const tbody = r.text.slice(bodyStart, bodyEnd);
    // Find positions of each label in tbody — descending by id puts k3 first.
    const k1Pos = tbody.indexOf("k1");
    const k2Pos = tbody.indexOf("k2");
    const k3Pos = tbody.indexOf("k3");
    expect(k3Pos).toBeGreaterThan(-1);
    expect(k2Pos).toBeGreaterThan(k3Pos);
    expect(k1Pos).toBeGreaterThan(k2Pos);
  });

  it("exports CSV with proper BOM", async () => {
    const r = await request(app.server)
      .get("/admin/keys.csv")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.text.charCodeAt(0)).toBe(0xfeff); // BOM
    // Brief's column list: id, user_email, label, key_prefix, created_at, revoked_at
    expect(r.text).toMatch(/user_email/);
    expect(r.text).toMatch(/key_prefix/);
  });

  it("handles empty state when no keys match", async () => {
    // Filter by revoked=yes with a future-dated impossible condition via the
    // userId path — no api_keys have user_id 999999, so the table is empty.
    const r = await request(app.server)
      .get("/admin/keys?userId=999999")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    const bodyStart = r.text.indexOf("<tbody");
    const bodyEnd = r.text.indexOf("</tbody>");
    const tbody = r.text.slice(bodyStart, bodyEnd);
    expect(tbody).not.toMatch(/<code>/);
  });
});

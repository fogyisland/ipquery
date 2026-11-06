// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { RowDataPacket } from "mysql2";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let userUid: number;

beforeAll(async () => {
  td = await createTestDb("admin-audit-enhanced");
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
  const user = await createUser(app.pool, { email: "u@x.com", passwordHash: "h", displayName: "U" });
  userUid = user.id;
  // Seed three query_log entries with distinct statuses so the filter test is
  // deterministic: id 1 = hit, id 2 = miss, id 3 = invalid. The default sort
  // is id desc, so the first visible row should have the highest id.
  await app.pool.query<RowDataPacket[]>(
    `INSERT INTO query_log (ip, ip_text, status, user_id, api_key_id, session_id, remote_addr, user_agent)
     VALUES (?, ?, 'hit', ?, NULL, NULL, NULL, NULL)`,
    [Buffer.from("8.8.8.8"), "8.8.8.8", userUid],
  );
  await app.pool.query<RowDataPacket[]>(
    `INSERT INTO query_log (ip, ip_text, status, user_id, api_key_id, session_id, remote_addr, user_agent)
     VALUES (?, ?, 'miss', ?, NULL, NULL, NULL, NULL)`,
    [Buffer.from("9.9.9.9"), "9.9.9.9", userUid],
  );
  await app.pool.query<RowDataPacket[]>(
    `INSERT INTO query_log (ip, ip_text, status, user_id, api_key_id, session_id, remote_addr, user_agent)
     VALUES (?, ?, 'invalid', ?, NULL, NULL, NULL, NULL)`,
    [Buffer.from("1.0.0.1"), "1.0.0.1", userUid],
  );
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

function tbodyOf(html: string): string {
  const start = html.indexOf("<tbody");
  const end = html.indexOf("</tbody>");
  return html.slice(start, end);
}

describe("admin audit enhanced", () => {
  it("filters by status=hit", async () => {
    const r = await request(app.server)
      .get("/admin/audit?status=hit")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    const tbody = tbodyOf(r.text);
    // Only the hit row should appear in tbody; miss + invalid must not.
    expect(tbody).toMatch(/8\.8\.8\.8/);
    expect(tbody).not.toMatch(/9\.9\.9\.9/);
    expect(tbody).not.toMatch(/1\.0\.0\.1/);
  });

  it("sorts by id desc by default", async () => {
    const r = await request(app.server)
      .get("/admin/audit")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    const tbody = tbodyOf(r.text);
    // 1.0.0.1 (id 3) must appear before 9.9.9.9 (id 2) and 8.8.8.8 (id 1).
    const p3 = tbody.indexOf("1.0.0.1");
    const p2 = tbody.indexOf("9.9.9.9");
    const p1 = tbody.indexOf("8.8.8.8");
    expect(p3).toBeGreaterThan(-1);
    expect(p2).toBeGreaterThan(p3);
    expect(p1).toBeGreaterThan(p2);
  });

  it("sorts by id asc with sort=id", async () => {
    // The new parseListQuery-driven route must accept the sort=id parameter
    // and reverse the order. The pre-existing route ignored sort entirely.
    const r = await request(app.server)
      .get("/admin/audit?sort=id")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    const tbody = tbodyOf(r.text);
    // 8.8.8.8 (id 1) must appear before 9.9.9.9 (id 2) and 1.0.0.1 (id 3).
    const p1 = tbody.indexOf("8.8.8.8");
    const p2 = tbody.indexOf("9.9.9.9");
    const p3 = tbody.indexOf("1.0.0.1");
    expect(p1).toBeGreaterThan(-1);
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThan(p2);
  });

  it("CSV endpoint still works", async () => {
    const r = await request(app.server)
      .get("/admin/audit.csv")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.text.split("\n")[0]).toContain("id,ts,ip_text");
    expect(r.text).toContain("8.8.8.8");
  });

  it("handles empty state with impossible filter", async () => {
    const r = await request(app.server)
      .get("/admin/audit?ipText=10.10.10.10")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    const tbody = tbodyOf(r.text);
    // No seeded row has ip_text = 10.10.10.10, so the body must contain no IP
    // text from our seed set.
    expect(tbody).not.toMatch(/8\.8\.8\.8/);
    expect(tbody).not.toMatch(/9\.9\.9\.9/);
    expect(tbody).not.toMatch(/1\.0\.0\.1/);
  });
});

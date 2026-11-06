// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
let adminUid: number;

beforeAll(async () => {
  td = await createTestDb("admin-users-enhanced");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "a@x",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminUid = admin.id;
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, adminUid, new Date(Date.now() + 3600_000));
  await createUser(app.pool, { email: "u1@x", passwordHash: "h", displayName: "U1" });
  await createUser(app.pool, { email: "u2@x", passwordHash: "h", displayName: "U2" });
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

async function csrfOf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server)
    .get("/admin/users")
    .set("Cookie", "sid=" + adminSid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
  const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}`, token: tokenMatch[1]! };
}

describe("admin users enhanced", () => {
  it("filters by role=admin", async () => {
    const r = await request(app.server)
      .get("/admin/users?role=admin")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/a@x/);
    expect(r.text).not.toMatch(/u1@x/);
  });

  it("sorts by id desc with sort=-id", async () => {
    const r = await request(app.server)
      .get("/admin/users?sort=-id")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    // First data row should be u2 (largest id)
    expect(r.text.indexOf("u2@x")).toBeLessThan(r.text.indexOf("u1@x"));
  });

  it("exports CSV with proper BOM", async () => {
    const r = await request(app.server)
      .get("/admin/users.csv")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.text.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(r.text).toMatch(/email/);
  });

  it("handles bulk disable", async () => {
    const { cookie, token } = await csrfOf();
    // Find u1/u2 ids - admin is id 1, u1=2, u2=3
    const [rows] = await td.pool.query<{ id: number }[] & { id: number }[]>(
      "SELECT id FROM users WHERE email IN (?, ?) ORDER BY id",
      ["u1@x", "u2@x"],
    );
    const ids = (rows as unknown as { id: number }[]).map((r) => r.id).join(",");
    const r = await request(app.server)
      .post("/admin/users/bulk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, action: "disable", ids });
    expect(r.status).toBe(302);
    const [check] = await td.pool.query<{ is_disabled: number }[] & { is_disabled: number }[]>(
      "SELECT is_disabled FROM users WHERE email IN (?, ?)",
      ["u1@x", "u2@x"],
    );
    const all = (check as unknown as { is_disabled: number }[]).every((row) => row.is_disabled === 1);
    expect(all).toBe(true);
  });
});

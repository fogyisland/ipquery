// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import request from "supertest";

let td: TestDb;

async function freshApp(): Promise<Awaited<ReturnType<typeof buildServer>>> {
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  return buildServer(cfg);
}

// FIX (Task 14): CSRF plugin requires BOTH `csrf` and `csrf_issued` cookies
// (see src/web/plugins/csrf.ts). The brief's test only sent the `csrf` cookie,
// causing every POST to fail with 403. This helper returns the paired cookie
// string + the token extracted from the cookie value.
async function getCsrfPair(): Promise<{ cookie: string; token: string }> {
  const app = await freshApp();
  try {
    const r = await request(app.server).get("/signup");
    const setCookie = r.headers["set-cookie"] as string[];
    const csrfLine = setCookie.find((c) => c.startsWith("csrf="))!;
    const issuedLine = setCookie.find((c) => c.startsWith("csrf_issued="))!;
    const bindLine = setCookie.find((c) => c.startsWith("csrf_bind="))!;
    const csrf = csrfLine.split(";")[0]!;
    const issued = issuedLine.split(";")[0]!;
    const bind = bindLine.split(";")[0]!;
    const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrf)!;
    return { cookie: `${csrf}; ${issued}; ${bind}`, token: tokenMatch[1]! };
  } finally {
    await app.close();
  }
}

beforeAll(async () => {
  td = await createTestDb("signup");
});
afterAll(async () => {
  await dropTestDb(td);
});

describe("signup", () => {
  it("GET renders form", async () => {
    const app = await freshApp();
    const r = await request(app.server).get("/signup");
    expect(r.status).toBe(200);
    expect(r.text).toContain("csrf");
    expect(r.text).toContain("注册");
    await app.close();
  });

  it("POST success creates user + sends verification", async () => {
    const app = await freshApp();
    const { cookie, token } = await getCsrfPair();
    const r = await request(app.server)
      .post("/signup")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "new@x.com", password: "Hello123World", displayName: "New", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("注册成功");

    const [users] = await app.pool.query("SELECT * FROM users WHERE email = ?", ["new@x.com"]);
    expect((users as unknown[]).length).toBe(1);
    await app.close();
  });

  it("rejects duplicate email", async () => {
    const app = await freshApp();
    const { cookie, token } = await getCsrfPair();
    await request(app.server)
      .post("/signup")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "dup@x.com", password: "Hello123World", displayName: "D", csrf: token });
    const r = await request(app.server)
      .post("/signup")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "dup@x.com", password: "Hello123World", displayName: "D", csrf: token });
    expect(r.status).toBe(409);
    await app.close();
  });

  it("rejects weak password", async () => {
    const app = await freshApp();
    const { cookie, token } = await getCsrfPair();
    const r = await request(app.server)
      .post("/signup")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: "w@x.com", password: "short", displayName: "W", csrf: token });
    expect(r.status).toBe(400);
    await app.close();
  });
});

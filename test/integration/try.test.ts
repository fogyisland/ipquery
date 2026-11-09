// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  td = await createTestDb("try");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

async function getCsrf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get("/try");
  const setCookie = (r.headers["set-cookie"] as string[]).find((c) => c.startsWith("csrf="))!;
  const issuedSetCookie = (r.headers["set-cookie"] as string[]).find((c) => c.startsWith("csrf_issued="))!;
  const bindSetCookie = (r.headers["set-cookie"] as string[]).find((c) => c.startsWith("csrf_bind="))!;
  const cookie = `${setCookie.split(";")[0]!}; ${issuedSetCookie.split(";")[0]!}; ${bindSetCookie.split(";")[0]!}`;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(setCookie);
  const token = tokenMatch ? tokenMatch[1]! : "";
  return { cookie, token };
}

describe("/try", () => {
  it("GET renders form", async () => {
    const r = await request(app.server).get("/try");
    expect(r.status).toBe(200);
    // Marketing redesign: plain POST form (no htmx). Assert on
    // action attribute and the input that the page must contain.
    expect(r.text).toContain('action="/try"');
    expect(r.text).toContain('name="ip"');
  });

  it("POST invalid IP returns invalid fragment on the same page", async () => {
    const { cookie, token } = await getCsrf();
    const r = await request(app.server)
      .post("/try")
      .set("Cookie", cookie)
      .type("form")
      .send({ ip: "not-an-ip", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("IP 格式无效");
  });

  it("POST valid IP with no record returns notfound on the same page", async () => {
    const { cookie, token } = await getCsrf();
    // 8.8.8.8 used to be used here, but it is one of the seeded
    // addresses — it was "not found" only because the seed rows were
    // stored in the wrong byte order (see migration 023). Now that they
    // are findable, use an address from a documentation range that the
    // seed data genuinely does not cover.
    const r = await request(app.server)
      .post("/try")
      .set("Cookie", cookie)
      .type("form")
      .send({ ip: "203.0.113.1", csrf: token });
    expect(r.status).toBe(200);
    expect(r.text).toContain("未找到记录");
  });

  it("POST without csrf returns 403", async () => {
    const { cookie } = await getCsrf();
    const r = await request(app.server)
      .post("/try")
      .set("Cookie", cookie)
      .type("form")
      .send({ ip: "8.8.8.8", csrf: "wrong" });
    expect(r.status).toBe(403);
  });
});

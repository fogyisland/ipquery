// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken, generateApiKey, hashToken } from "../../src/web/auth/tokens";
import { createApiKey, findActiveApiKeyByHash } from "../../src/storage/apiKeys";
import request from "supertest";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let userId: number;
let sid: string;

beforeAll(async () => {
  td = await createTestDb("dash-keys");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  // server.ts already registers dashboardRoutes as part of the production
  // route set, so we just build the server and get a fully-wired app.
  app = await buildServer(cfg);
  const u = await createUser(app.pool, { email: "k@x.com", passwordHash: "h", displayName: "K" });
  userId = u.id;
  sid = generateToken(16);
  await createSession(app.pool, sid, userId, new Date(Date.now() + 3600_000));
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

async function csrfOf(
  app: Awaited<ReturnType<typeof buildServer>>,
): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server)
    .get("/dashboard/keys")
    .set("Cookie", "sid=" + sid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
  const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}`, token: tokenMatch[1]! };
}

describe("dashboard API keys", () => {
  it("GET /dashboard/keys empty", async () => {
    const r = await request(app.server)
      .get("/dashboard/keys")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    expect(r.text).toContain("暂无 API Key");
  });

  it("POST creates key and shows plaintext once", async () => {
    const { cookie, token } = await csrfOf(app);
    const r = await request(app.server)
      .post("/dashboard/keys")
      .set("Cookie", "sid=" + sid + "; " + cookie)
      .type("form")
      .send({ label: "my key", csrf: token });
    expect(r.status).toBe(200);
    const m = /ipq_[A-Z2-7]{52}/.exec(r.text);
    expect(m).not.toBeNull();
    // Verify the key is in DB
    const found = await findActiveApiKeyByHash(app.pool, hashToken(m![0]));
    expect(found?.label).toBe("my key");
  });

  it("GET does not show plaintext", async () => {
    const r = await request(app.server)
      .get("/dashboard/keys")
      .set("Cookie", "sid=" + sid);
    expect(r.text).not.toMatch(/ipq_[A-Z2-7]{52}/);
  });

  it("POST /revoke deactivates", async () => {
    const plain = generateApiKey();
    const key = await createApiKey(app.pool, userId, "to-revoke", hashToken(plain), plain.slice(0, 8));
    const { cookie, token } = await csrfOf(app);
    const r = await request(app.server)
      .post("/dashboard/keys/" + key.id + "/revoke")
      .set("Cookie", "sid=" + sid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);
    expect(await findActiveApiKeyByHash(app.pool, hashToken(plain))).toBeNull();
  });

  it("cannot revoke another user key (404)", async () => {
    const otherUid = (await createUser(app.pool, { email: "o@x.com", passwordHash: "h", displayName: "O" }))
      .id;
    const plain = generateApiKey();
    const key = await createApiKey(app.pool, otherUid, "other", hashToken(plain), plain.slice(0, 8));
    const { cookie, token } = await csrfOf(app);
    const r = await request(app.server)
      .post("/dashboard/keys/" + key.id + "/revoke")
      .set("Cookie", "sid=" + sid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(404);
  });

  it("rendered HTML has no inline event handlers (CSP-safe)", async () => {
    const r = await request(app.server)
      .get("/dashboard/keys")
      .set("Cookie", "sid=" + sid);
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/on(?:click|submit)=/);
  });
});

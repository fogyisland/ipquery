// SPDX-License-Identifier: MIT
//
// POST /verify/resend/:userId sends a real email to a real user.
//
// Two protections are pinned here:
//
//  - The route carries its own rate limit. The global limit is
//    60/minute, which is far too generous for an endpoint that sends an
//    email per call.
//
//  - The cooldown is keyed on the REQUESTER, not on the target
//    userId. The cooldown used to be keyed on the target, which stopped
//    repeated sends to the same user but did nothing about
//    enumeration: a script walking userId 1..N would send one email to
//    every registered user and be blocked by nothing.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { csrfTripleFrom } from "../helpers/csrf";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { hashPassword } from "../../src/web/auth/password";
import { _resetForTests as resetResendCooldown } from "../../src/web/plugins/verifyResendCooldown";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let userId: number;

async function getCsrfCookieAndToken(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server).get("/login");
  return csrfTripleFrom(r.headers["set-cookie"] as string[]);
}

beforeAll(async () => {
  td = await createTestDb("verifyresend");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);

  const hash = await hashPassword("Str0ngPassw0rd!");
  const u = await createUser(app.pool, {
    email: "resend-target@example.com",
    passwordHash: hash,
    displayName: "Target",
  });
  userId = u.id;
}, 180_000);

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

beforeEach(async () => {
  resetResendCooldown();
  // Clear the per-target verification rows so each test starts clean.
  await app.pool.query("DELETE FROM email_verifications");
});

describe("POST /verify/resend/:userId", () => {
  it("rejects a request with no CSRF token", async () => {
    const res = await request(app.server).post(`/verify/resend/${userId}`);
    expect(res.status).toBe(403);
  });

  it("sends a verification email for a valid user id", async () => {
    const { cookie, token } = await getCsrfCookieAndToken();
    const res = await request(app.server)
      .post(`/verify/resend/${userId}`)
      .set("cookie", cookie)
      .send({ csrf: token });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/login");
    const [rows] = await app.pool.query(
      "SELECT COUNT(*) AS c FROM email_verifications WHERE user_id = ?",
      [userId],
    );
    expect(Number((rows[0] as { c: number }).c)).toBe(1);
  });

  it("returns 404 for an unknown user id without creating a verification", async () => {
    const { cookie, token } = await getCsrfCookieAndToken();
    const res = await request(app.server)
      .post("/verify/resend/999999999")
      .set("cookie", cookie)
      .send({ csrf: token });
    expect(res.status).toBe(404);
    const [rows] = await app.pool.query("SELECT COUNT(*) AS c FROM email_verifications");
    expect(Number((rows[0] as { c: number }).c)).toBe(0);
  });

  it("blocks a second resend for a DIFFERENT user id from the same requester", async () => {
    // The regression: the cooldown used to be keyed on the target
    // userId, so this second call — for a different user — sailed
    // through and sent a second email.
    const other = await createUser(app.pool, {
      email: "resend-target-2@example.com",
      passwordHash: await hashPassword("Str0ngPassw0rd!"),
      displayName: "Target2",
    });

    const first = await getCsrfCookieAndToken();
    const res1 = await request(app.server)
      .post(`/verify/resend/${userId}`)
      .set("cookie", first.cookie)
      .send({ csrf: first.token });
    expect(res1.status).toBe(302);
    expect(res1.headers.location).not.toContain("cooldown=1");

    const second = await getCsrfCookieAndToken();
    const res2 = await request(app.server)
      .post(`/verify/resend/${other.id}`)
      .set("cookie", second.cookie)
      .send({ csrf: second.token });
    expect(res2.status).toBe(429);
    expect(res2.headers.location).toContain("cooldown=1");

    // Only one verification was created — the second was refused.
    const [rows] = await app.pool.query("SELECT COUNT(*) AS c FROM email_verifications");
    expect(Number((rows[0] as { c: number }).c)).toBe(1);
  });

  it("rejects a malformed user id", async () => {
    const { cookie, token } = await getCsrfCookieAndToken();
    const res = await request(app.server)
      .post("/verify/resend/not-a-number")
      .set("cookie", cookie)
      .send({ csrf: token });
    expect(res.status).toBe(404);
    const [rows] = await app.pool.query("SELECT COUNT(*) AS c FROM email_verifications");
    expect(Number((rows[0] as { c: number }).c)).toBe(0);
  });
});

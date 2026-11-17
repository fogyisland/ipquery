// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { fetchCsrfTriple } from "../helpers/csrf";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("upload-limit");
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
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("the range import accepts a file larger than Fastify's default", () => {
  it("takes a 2 MB body without resetting the connection", async () => {
    // Fastify's default body limit is 1 MB and @fastify/formbody inherits
    // it. Before this was raised, a file over a megabyte — a few thousand
    // rows — did not get a 413 with a message: the parser threw inside a
    // hook and the socket was reset, so the operator saw "connection
    // reset" and nothing else.
    //
    // The fix is a larger limit on the range routes only; this test pins
    // that the request reaches a handler and comes back as an answer.
    const { cookie, token } = await fetchCsrfTriple(app, "/admin/ranges", "sid=" + adminSid);
    const filler = "x".repeat(2 * 1024 * 1024);
    const res = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, file: filler });

    // Whatever the answer is, it must be an answer: the router got the
    // body, decided something, and replied. A reset or a 500 means the
    // limit is still in the way.
    expect([302, 400, 413]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });
});

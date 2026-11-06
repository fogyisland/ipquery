// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  td = await createTestDb("home");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("home (marketing landing)", () => {
  // Marketing redesign: home renders inside layouts/marketing — top nav +
  // hero + footer, no sidebar. The hero carries the IP query form (plain
  // POST, CSP-compliant) plus signature 16x16 byte grid.
  it("GET / returns 200 with marketing chrome, hero form, and IP byte grid", async () => {
    const r = await request(app.server).get("/");
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/<aside class="sidebar">/);
    expect(r.text).toMatch(/class="m-topnav"/);
    expect(r.text).toMatch(/class="m-hero"/);
    expect(r.text).toMatch(/class="m-ipgrid"/);
    // Query form: POST to /try (plain form — no JS, CSP compliant).
    expect(r.text).toMatch(/<form[^>]*method="POST"[^>]*action="\/try"/);
    expect(r.text).toMatch(/name="ip"/);
    // CSRF token embedded in form
    expect(r.text).toMatch(/name="csrf"/);
    // Footer with brand
    expect(r.text).toMatch(/class="m-footer"/);
  });
});

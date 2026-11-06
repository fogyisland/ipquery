// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { listProviderConfigs, updateProviderConfig } from "../../src/storage/ingestProviders";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("autoreen-route");
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

beforeEach(async () => {
  // Reset every provider to known state before each test.
  for (const name of ["ip-api", "ipinfo", "iplocate", "freeipapi", "ipapi-co"]) {
    await updateProviderConfig(td.pool, name, {
      enabled: true,
      autoReenableAt: null,
      autoDisabledReason: null,
    });
  }
});

async function csrfPair(): Promise<{ cookie: string; token: string }> {
  // GET the ingest page to obtain fresh csrf cookies. Same pattern
  // as admin.users.test.ts. PR2: was /admin/unknown-ips.
  const r = await request(app.server)
    .get("/admin/ingest")
    .set("Cookie", "sid=" + adminSid);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
  const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}`, token: tokenMatch[1]! };
}

describe("POST /admin/providers/:name — manual toggle wins over reaper", () => {
  it("admin disables a provider; the row reflects enabled=0 (reap was a no-op)", async () => {
    // Sanity: provider starts enabled.
    let configs = await listProviderConfigs(td.pool);
    expect(configs.find((r) => r.name === "ip-api")!.enabled).toBe(true);

    const { cookie, token } = await csrfPair();
    // POST the toggle form: enabled=off means unchecked checkbox.
    const r = await request(app.server)
      .post("/admin/providers/ip-api")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, enabled: "off", apiKey: "" });
    expect(r.status).toBe(302); // redirect back to /admin/providers
    expect(r.headers.location).toMatch(/\/admin\/providers/);

    // The provider should now be disabled.
    configs = await listProviderConfigs(td.pool);
    expect(configs.find((r) => r.name === "ip-api")!.enabled).toBe(false);
  });

  it("admin enables a provider whose auto_reenable_at is in the future — reap does NOT touch it", async () => {
    // Setup: provider is disabled with a far-future auto_reenable_at.
    // The reaper's WHERE clause filters on auto_reenable_at <= NOW()
    // so this row is OUT of scope — manual toggle should win.
    const future = new Date(Date.now() + 60 * 60_000); // 1h ahead
    await updateProviderConfig(td.pool, "ipinfo", {
      enabled: false,
      autoReenableAt: future,
      autoDisabledReason: "429 rate limited",
    });

    const { cookie, token } = await csrfPair();
    const r = await request(app.server)
      .post("/admin/providers/ipinfo")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, enabled: "on", apiKey: "" });
    expect(r.status).toBe(302);

    // Provider is enabled (manual toggle won). The reaper did NOT
    // touch this row because the WHERE clause filters on
    // auto_reenable_at <= NOW().
    const configs = await listProviderConfigs(td.pool);
    const row = configs.find((r) => r.name === "ipinfo")!;
    expect(row.enabled).toBe(true);
  });

  it("admin disables a provider whose auto_reenable_at is in the past — reap first clears, then manual disable applies", async () => {
    // Setup: provider is disabled with a PAST auto_reenable_at. Without
    // reap-first, the manual disable would just set enabled=false.
    // WITH reap-first, the reaper sees auto_reenable_at <= NOW() and
    // re-enables the provider first (clearing auto_reenable_at), then
    // the admin disable sets enabled=false. Final assertion is the
    // same either way — but the POST must complete cleanly (reap
    // doesn't error on a row that already exists with the right state).
    const past = new Date(Date.now() - 5 * 60_000); // 5min ago
    await updateProviderConfig(td.pool, "iplocate", {
      enabled: false,
      autoReenableAt: past,
      autoDisabledReason: "429 rate limited",
    });

    const { cookie, token } = await csrfPair();
    const r = await request(app.server)
      .post("/admin/providers/iplocate")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, enabled: "off", apiKey: "" });
    expect(r.status).toBe(302);

    // Final state: disabled (admin won).
    const configs = await listProviderConfigs(td.pool);
    expect(configs.find((r) => r.name === "iplocate")!.enabled).toBe(false);
  });
});

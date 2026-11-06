// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { _resetProviderHealthCache } from "../../src/storage/providerErrorLog";
import { deleteCustomProvider, listProviderConfigs } from "../../src/storage/ingestProviders";

// DNS mock so SSRF-guard accepts "api.example.com" etc. in tests.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]),
}));

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("custom-prov");
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
  _resetProviderHealthCache();
  await td.pool.query(`DELETE FROM ingest_providers WHERE is_custom = 1`);
});

const validBody = (over: Record<string, string> = {}): Record<string, string> => ({
  name: "demo",
  displayName: "Demo Provider",
  urlTemplate: "https://api.example.com/{ip}",
  method: "GET",
  responseFormat: "json",
  countryPath: "country.code",
  cityPath: "",
  asnPath: "",
  timeoutMs: "5000",
  requestBody: "",
  apiKey: "",
  enabled: "on",
  ...over,
});

/** GET-then-POST pattern that mirrors the browser flow: the GET seeds
 *  the csrf / csrf_issued cookies, then we pull the csrf token out of
 *  the response and send it in the POST body. Mirrors the
 *  auditlog-instrumentation.test.ts pattern. PR2: was
 *  /admin/unknown-ips/providers/custom, now /admin/providers. */
async function csrfOf(): Promise<{ cookie: string; token: string }> {
  const r = await request(app.server)
    .get("/admin/providers")
    .set("Cookie", "sid=" + adminSid);
  expect(r.status).toBe(200);
  const cookies = r.headers["set-cookie"] as string[];
  const csrfLine = cookies.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
  const issuedLine = cookies.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfLine)!;
  return { cookie: `${csrfLine}; ${issuedLine}`, token: tokenMatch[1]! };
}

async function csrfPost(path: string, body: Record<string, string>) {
  const { cookie, token } = await csrfOf();
  return request(app.server)
    .post(path)
    .set("Cookie", "sid=" + adminSid + "; " + cookie)
    .type("form")
    .send({ ...body, csrf: token });
}

describe("POST /admin/providers/custom", () => {
  it("accepts a valid HTTPS URL and inserts a row", async () => {
    const r = await csrfPost("/admin/providers/custom", validBody());
    expect(r.status).toBe(302);
    const configs = await listProviderConfigs(td.pool);
    const row = configs.find((c) => c.name === "demo");
    expect(row).toBeDefined();
    expect(row?.isCustom).toBe(true);
    expect(row?.customUrlTemplate).toBe("https://api.example.com/{ip}");
    expect(row?.customCountryPath).toBe("country.code");
    expect(row?.apiKey).toBeNull();
  });

  it("rejects http://localhost/foo (SSRF guard)", async () => {
    const r = await csrfPost("/admin/providers/custom", validBody({ urlTemplate: "http://localhost/foo" }));
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/blocked|invalidUrl|防御/);
    const configs = await listProviderConfigs(td.pool);
    expect(configs.find((c) => c.name === "demo")).toBeUndefined();
  });

  it("rejects http://127.0.0.1/foo (SSRF guard)", async () => {
    const r = await csrfPost("/admin/providers/custom", validBody({ urlTemplate: "http://127.0.0.1/foo" }));
    expect(r.status).toBe(200);
    const configs = await listProviderConfigs(td.pool);
    expect(configs.find((c) => c.name === "demo")).toBeUndefined();
  });

  it("rejects a hostname that resolves to a blocked IP (DNS check)", async () => {
    const dns = await import("node:dns/promises");
    (dns.lookup as unknown as { mockResolvedValueOnce: (_v: unknown) => void }).mockResolvedValueOnce([
      { address: "169.254.169.254", family: 4 },
    ]);
    const r = await csrfPost(
      "/admin/providers/custom",
      validBody({ urlTemplate: "http://attacker.example/" }),
    );
    expect(r.status).toBe(200);
    const configs = await listProviderConfigs(td.pool);
    expect(configs.find((c) => c.name === "demo")).toBeUndefined();
  });

  it("rejects a name that collides with a built-in provider", async () => {
    const r = await csrfPost("/admin/providers/custom", validBody({ name: "ip-api" }));
    expect(r.status).toBe(200);
    const configs = await listProviderConfigs(td.pool);
    const ipApi = configs.find((c) => c.name === "ip-api")!;
    expect(ipApi.isCustom).toBe(false);
  });
});

describe("POST /admin/providers/custom/:name/delete", () => {
  it("refuses to delete a built-in provider", async () => {
    const r = await csrfPost("/admin/providers/custom/ip-api/delete", {});
    expect(r.status).toBe(302);
    const configs = await listProviderConfigs(td.pool);
    expect(configs.find((c) => c.name === "ip-api")).toBeDefined();
  });

  it("removes a custom row by name", async () => {
    await td.pool.query(
      `INSERT INTO ingest_providers
         (name, display_name, free_quota, enabled, is_custom,
          custom_url_template, custom_method, custom_response_format, custom_country_path)
       VALUES ('demo', 'Demo', '', 1, 1,
          'https://api.example.com/{ip}', 'GET', 'json', 'country.code')`,
    );
    const removed = await deleteCustomProvider(td.pool, "demo");
    expect(removed).toBe(1);
    const configs = await listProviderConfigs(td.pool);
    expect(configs.find((c) => c.name === "demo")).toBeUndefined();
  });

  it("redirects after a successful delete (HTTP 302)", async () => {
    await td.pool.query(
      `INSERT INTO ingest_providers
         (name, display_name, free_quota, enabled, is_custom,
          custom_url_template, custom_method, custom_response_format, custom_country_path)
       VALUES ('demo', 'Demo', '', 1, 1,
          'https://api.example.com/{ip}', 'GET', 'json', 'country.code')`,
    );
    const r = await csrfPost("/admin/providers/custom/demo/delete", {});
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/\/admin\/providers/);
  });
});

describe("POST /admin/providers/custom/:name/test", () => {
  it("returns 400 when ip is missing", async () => {
    const r = await csrfPost("/admin/providers/custom/demo/test", {});
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, error: "ip_required" });
  });

  it("returns 404 when the provider does not exist", async () => {
    const r = await csrfPost("/admin/providers/custom/missing/test", { ip: "8.8.8.8" });
    expect(r.status).toBe(404);
  });

  it("runs a lookup against a real-ish URL (mocked) and returns the record", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ country: { code: "US" }, city: "Mountain View" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await td.pool.query(
        `INSERT INTO ingest_providers
           (name, display_name, free_quota, enabled, is_custom,
            custom_url_template, custom_method, custom_response_format, custom_country_path, custom_city_path)
         VALUES ('demo', 'Demo', '', 1, 1,
            'https://api.example.com/{ip}', 'GET', 'json', 'country.code', 'city')`,
      );
      const r = await csrfPost("/admin/providers/custom/demo/test", { ip: "8.8.8.8" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        ok: true,
        record: { countryCode: "US", city: "Mountain View" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

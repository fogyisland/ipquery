// SPDX-License-Identifier: MIT
// Integration test: the wizard's step 2 offers the PUBLIC address.
//
// The startup-generated .env carries WEB_BASE_URL=http://localhost:3880 —
// a placeholder, because at boot time the server has not seen a request
// and cannot know its own domain. That placeholder is not harmless:
// WEB_BASE_URL ends up in the verification email, the password-reset
// email and the API address shown on the keys page. Left as a loopback
// address, all three hand a real user an address they cannot reach.
//
// So step 2 must offer the address the operator is actually browsing,
// derived from the request's Host header.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { buildServer } from "../../src/api/server";
import { isolateEnvFile, type EnvIsolation } from "../helpers/envIsolation";

const TEST_DB = "ipquery_test_init_env_baseurl";

let pool: mysql.Pool;
let app: Awaited<ReturnType<typeof buildServer>>;
let envIsolation: EnvIsolation | undefined;

async function dropAndCreate(): Promise<mysql.Pool> {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.query(`CREATE DATABASE \`${TEST_DB}\``);
  await root.end();
  const created = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: TEST_DB,
    connectionLimit: 2,
    multipleStatements: true,
    timezone: "Z",
    dateStrings: false,
  });
  await runMigrations(created);
  return created;
}

async function dropDb(): Promise<void> {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.end();
}

/** The value of the baseUrl input on the rendered step-2 form. */
function extractBaseUrl(html: string): string {
  const m = /name="baseUrl"[^>]*value="([^"]*)"/.exec(html);
  if (!m) throw new Error("baseUrl input not found in page");
  return m[1]!;
}

beforeAll(async () => {
  // The wizard reads and writes .env. Isolate it so the developer's own
  // project .env is neither read nor overwritten.
  envIsolation = isolateEnvFile();
  pool = await dropAndCreate();
  const cfg = loadConfig();
  cfg.db.database = TEST_DB;
  app = await buildServer(cfg);
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  await dropDb();
  envIsolation?.restore();
});

describe("step 2 offers the public address", () => {
  it("prefills the host the operator is browsing", async () => {
    const r = await request(app.server).get("/init/env").set("Host", "ip.example.com");
    expect(r.status).toBe(200);
    expect(extractBaseUrl(r.text)).toBe("http://ip.example.com");
  });

  it("does not offer the localhost placeholder", async () => {
    const r = await request(app.server).get("/init/env").set("Host", "ip.example.com");
    expect(extractBaseUrl(r.text)).not.toContain("localhost");
  });

  it("keeps the port when the host carries one", async () => {
    const r = await request(app.server).get("/init/env").set("Host", "ip.example.com:8443");
    expect(extractBaseUrl(r.text)).toBe("http://ip.example.com:8443");
  });

  it("uses https when the proxy says the client was on https", async () => {
    // The connection to Node is plain http behind a TLS-terminating proxy,
    // so req.protocol is "http" here. The forwarded header is what
    // describes the PUBLIC address.
    const r = await request(app.server)
      .get("/init/env")
      .set("Host", "ip.example.com")
      .set("X-Forwarded-Proto", "https");
    expect(extractBaseUrl(r.text)).toBe("https://ip.example.com");
  });

  it("takes the first entry of a chained X-Forwarded-Proto", async () => {
    // A chain of proxies appends to the header. The first entry is the
    // original client's scheme — the one describing the public address.
    const r = await request(app.server)
      .get("/init/env")
      .set("Host", "ip.example.com")
      .set("X-Forwarded-Proto", "https, http");
    expect(extractBaseUrl(r.text)).toBe("https://ip.example.com");
  });

  it("ignores a forwarded scheme it does not recognise", async () => {
    const r = await request(app.server)
      .get("/init/env")
      .set("Host", "ip.example.com")
      .set("X-Forwarded-Proto", "gopher");
    expect(extractBaseUrl(r.text)).toBe("http://ip.example.com");
  });

  it("refuses a Host header that is not a host", async () => {
    // The value ends up in outgoing email. A Host carrying a scheme or a
    // path is not a host, and it must never reach the .env.
    for (const bogus of [
      "evil.example.com/path",
      "http://evil.example.com",
      "evil.example.com extra",
      "user@evil.example.com",
    ]) {
      const r = await request(app.server).get("/init/env").set("Host", bogus);
      expect(r.status).toBe(200);
      expect(extractBaseUrl(r.text)).not.toContain("evil");
    }
  });

  it("never renders a secret into the page", async () => {
    const r = await request(app.server).get("/init/env").set("Host", "ip.example.com");
    // The startup generator may have written secrets into the isolated
    // .env. They must not appear in the HTML — a secret in a template is
    // in the browser cache and in every proxy log along the way.
    expect(r.text).not.toMatch(/SESSION_SECRET=[A-Za-z0-9+/=]{20,}/);
    expect(r.text).not.toMatch(/CSRF_SECRET=[A-Za-z0-9+/=]{20,}/);
  });

  it("keeps a base URL the operator already set", async () => {
    // Once the operator has confirmed an address, the wizard must not
    // second-guess it with the current request's host.
    const fs = await import("node:fs");
    fs.writeFileSync(
      envIsolation!.file,
      ["WEB_BASE_URL=https://chosen.example.com", "SESSION_SECRET=x", "CSRF_SECRET=y"].join("\n"),
      "utf8",
    );
    try {
      const r = await request(app.server).get("/init/env").set("Host", "other.example.com");
      expect(extractBaseUrl(r.text)).toBe("https://chosen.example.com");
    } finally {
      fs.rmSync(envIsolation!.file, { force: true });
    }
  });
});

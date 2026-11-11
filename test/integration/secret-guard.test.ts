// SPDX-License-Identifier: MIT
//
// The service must not silently sign session cookies with a well-known
// constant.
//
// The cookie plugin falls back to the literal "dev-only-secret-change-me"
// when SESSION_SECRET and CSRF_SECRET are both empty. That fallback is
// fine in development, but on a real server it means every session
// cookie is signed with a value that is published in this repository —
// anyone could forge an admin session.
//
// The original guard checked `NODE_ENV === "production"`. Nothing in
// the project ever SETS NODE_ENV — not .env.example, not install.sh,
// not the Baota guide — so the check never fired in a real deployment.
//
// The rule now is:
//   - NODE_ENV unset or anything but development/test  → production
//   - an UNINITIALIZED system may run the first-run wizard with the
//     placeholder secret (the wizard does not collect secrets, so
//     refusing to boot would make it unreachable)
//   - an INITIALIZED system must have real secrets, because that is
//     where real session cookies get signed
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { runMigrations } from "../../src/storage/migrations/runner";
import { markInitialized } from "../../src/storage/settings";

const TEST_DB = "ipquery_test_secret_guard";
let pool: mysql.Pool;

beforeAll(async () => {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.query(`CREATE DATABASE ${TEST_DB}`);
  await root.end();

  pool = mysql.createPool({
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
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.end();
});

/** A config with the given secrets, pointed at the test database. */
function configWith(secrets: { session?: string; csrf?: string }) {
  const cfg = loadConfig();
  cfg.db.database = TEST_DB;
  cfg.web.sessionSecret = secrets.session ?? "";
  cfg.web.csrfSecret = secrets.csrf ?? "";
  return cfg;
}

describe("the secret guard refuses to run an initialized system without secrets", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    // NODE_ENV unset is the real-world case: nothing in the project
    // sets it, so the guard must treat "unset" as production.
    delete process.env.NODE_ENV;
    await pool.query("DELETE FROM settings WHERE k = 'initialized_at'");
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("refuses to start an INITIALIZED system with no secrets", async () => {
    await markInitialized(pool);
    await expect(buildServer(configWith({}))).rejects.toThrow(/CSRF_SECRET/);
    await expect(buildServer(configWith({}))).rejects.toThrow(/SESSION_SECRET/);
  });

  it("refuses when only one of the two secrets is set", async () => {
    await markInitialized(pool);
    // A missing CSRF_SECRET is just as fatal as a missing session one:
    // the CSRF plugin falls back to the session secret, but a
    // half-configured file is a mistake worth surfacing.
    await expect(buildServer(configWith({ session: "a".repeat(48) }))).rejects.toThrow(
      /CSRF_SECRET/,
    );
    await expect(buildServer(configWith({ csrf: "b".repeat(48) }))).rejects.toThrow(
      /SESSION_SECRET/,
    );
  });

  it("starts an INITIALIZED system when both secrets are present", async () => {
    await markInitialized(pool);
    const app = await buildServer(
      configWith({ session: "s".repeat(48), csrf: "c".repeat(48) }),
    );
    await app.close();
  });

  it("allows an UNINITIALIZED system to start without secrets (the wizard)", async () => {
    // The first-run wizard does not collect secrets — it covers the
    // database, the site, the seed mode and the admin account. If the
    // guard refused to boot here, a fresh install could never reach
    // /init and the install would be unfinishable.
    await expect(buildServer(configWith({}))).resolves.toBeDefined();
  });

  it("the error names the environment it refused in", async () => {
    await markInitialized(pool);
    process.env.NODE_ENV = "production";
    await expect(buildServer(configWith({}))).rejects.toThrow(/refusing to start in production/);
  });

  it("NODE_ENV=development skips the guard entirely", async () => {
    await markInitialized(pool);
    process.env.NODE_ENV = "development";
    const app = await buildServer(configWith({}));
    await app.close();
  });
});

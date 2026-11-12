// SPDX-License-Identifier: MIT
//
// Boot without a database, and configure one from the wizard.
//
// The scenario this file locks down is the one that made a fresh
// install impossible:
//
//   1. The operator deploys the release bundle. There is no .env yet,
//      or it holds the placeholder password.
//   2. `node dist/cli.js serve` fails with
//      "Access denied for user 'root'@'localhost' (using password: YES)"
//      and the process exits.
//   3. The setup wizard that would let them fix exactly that is served
//      BY the process that just died.
//
// The fix has two halves, and both are pinned here:
//
//   A. The server starts anyway when the database cannot be reached, in
//      DEGRADED mode: the wizard is served, everything else answers 503.
//
//   B. The wizard's database step actually configures the database —
//      host, port, user, password, database name — persists it to .env,
//      re-points the live pool and migrates the schema, with no restart.
//
// The .env write is the load-bearing part. The database password cannot
// live in the database (the database is the thing that is broken) and
// must not live in git, so .env is the only place both the failed boot
// and the successful one can reach.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { isDbUnreachableError, describeDbError, envFilePath } from "../../src/api/dbBootstrap";

/** The database the wizard will be pointed at. */
const TARGET_DB = "ipquery_test_degraded_target";
/** A port nothing is listening on — used for the "cannot connect" case. */
const DEAD_PORT = 1;

let rootConn: mysql.Connection;
let originalCwd: string;
let originalEnvContents: string | null;
let envExisted: boolean;

beforeAll(async () => {
  const cfg = loadConfig();
  rootConn = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await rootConn.query(`DROP DATABASE IF EXISTS \`${TARGET_DB}\``);
  await rootConn.query(
    `CREATE DATABASE \`${TARGET_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
});

afterAll(async () => {
  if (rootConn) {
    await rootConn.query(`DROP DATABASE IF EXISTS \`${TARGET_DB}\``);
    await rootConn.end();
  }
});

beforeEach(() => {
  // The wizard writes to .env in the process CWD. Point the CWD at a
  // scratch directory so the repository's own .env is never touched.
  originalCwd = process.cwd();
  const scratch = path.join(originalCwd, "test", "tmp-degraded-env");
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  process.chdir(scratch);

  const envPath = envFilePath();
  envExisted = fs.existsSync(envPath);
  originalEnvContents = envExisted ? fs.readFileSync(envPath, "utf8") : null;
});

afterEach(() => {
  process.chdir(originalCwd);
  const scratch = path.join(originalCwd, "test", "tmp-degraded-env");
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A config pointing at a port where nothing listens. */
function unreachableConfig() {
  const cfg = loadConfig();
  cfg.db.host = "127.0.0.1";
  cfg.db.port = DEAD_PORT;
  cfg.db.user = "nobody";
  cfg.db.password = "nopassword";
  cfg.db.database = "does_not_exist";
  cfg.web.sessionSecret = "s".repeat(48);
  cfg.web.csrfSecret = "c".repeat(48);
  return cfg;
}

/** A config pointing at the real test database. */
function reachableConfig() {
  const cfg = loadConfig();
  cfg.db.database = TARGET_DB;
  cfg.web.sessionSecret = "s".repeat(48);
  cfg.web.csrfSecret = "c".repeat(48);
  return cfg;
}

/** Extract the CSRF token from a rendered wizard page. */
function readCsrf(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  if (!match) throw new Error("no CSRF token in the rendered page");
  return match[1]!;
}

/**
 * Open a wizard page and return a cookie-carrying agent plus the CSRF
 * token from that page.
 *
 * The agent matters: the CSRF check compares the form field against the
 * `csrf` cookie AND the httpOnly `csrf_bind` cookie, so a POST made
 * without the cookie jar fails with 403 no matter how correct the token
 * is.
 */
async function openWizard(
  app: Awaited<ReturnType<typeof buildServer>>,
  url: string,
): Promise<{ agent: ReturnType<typeof request.agent>; csrf: string }> {
  const agent = request.agent(app.server);
  const page = await agent.get(url);
  return { agent, csrf: readCsrf(page.text) };
}

describe("the error classifier", () => {
  it("recognises the errors that mean 'the database is unreachable'", () => {
    for (const code of [
      "ECONNREFUSED",
      "ER_ACCESS_DENIED_ERROR",
      "ER_BAD_DB_ERROR",
      "ETIMEDOUT",
      "ENOTFOUND",
    ]) {
      expect(isDbUnreachableError({ code }), code).toBe(true);
    }
  });

  it("does NOT swallow errors that mean 'the schema is broken'", () => {
    // A migration that ran and then failed on its own SQL is a real
    // failure. Degrading on it would turn a bug into a silently
    // half-working install.
    for (const code of ["ER_PARSE_ERROR", "ER_DUP_FIELDNAME", "ER_NO_SUCH_TABLE"]) {
      expect(isDbUnreachableError({ code }), code).toBe(false);
    }
  });

  it("says something actionable for each failure", () => {
    expect(describeDbError({ code: "ECONNREFUSED" })).toMatch(/refused/i);
    expect(describeDbError({ code: "ER_ACCESS_DENIED_ERROR" })).toMatch(/credentials/i);
    expect(describeDbError({ code: "ER_BAD_DB_ERROR" })).toMatch(/does not exist/i);
  });
});

describe("a server that cannot reach its database", () => {
  it("starts anyway instead of exiting", async () => {
    // The whole point: the process must not die, because the page that
    // fixes the problem lives inside it.
    const app = await buildServer(unreachableConfig());
    expect(app.dbDegraded).toBe(true);
    await app.close();
  }, 60_000);

  it("serves the setup wizard", async () => {
    const app = await buildServer(unreachableConfig());
    const res = await app.inject({ method: "GET", url: "/init" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("/init/database");
    await app.close();
  }, 60_000);

  it("serves the database step with the current (broken) values", async () => {
    const app = await buildServer(unreachableConfig());
    const res = await app.inject({ method: "GET", url: "/init/database" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="host"');
    expect(res.body).toContain('name="password"');
    // The page must say the database is not reachable — that changes
    // what the operator has to do. The default locale is zh-CN, so the
    // banner is in Chinese.
    expect(res.body).toMatch(/仅向导|setup-only mode/);
    await app.close();
  }, 60_000);

  it("answers 503 — not a stack trace — on the public API routes", async () => {
    const app = await buildServer(unreachableConfig());
    for (const url of ["/lookup?ip=8.8.8.8", "/stats"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(503);
      expect(res.body, url).not.toMatch(/ER_ACCESS_DENIED|at Object\.|node_modules/);
    }
    await app.close();
  }, 60_000);

  it("answers 503 — not 500 — when a stale session cookie is present", async () => {
    // The session hook is an onRequest hook that queries the database: it
    // loads the session behind the `sid` cookie. If the degraded gate were
    // registered after it, that hook would run first, query a dead pool,
    // and the request would come back 500 instead of the 503 that tells
    // the operator what to do.
    //
    // This is not hypothetical: a browser that visited the site before
    // the database went down still carries the `sid` cookie, so every API
    // call would 500. The gate has to be registered BEFORE the session
    // hook — see src/web/plugins/degradedGate.ts.
    const app = await buildServer(unreachableConfig());
    const res = await app.inject({
      method: "GET",
      url: "/lookup?ip=8.8.8.8",
      headers: { cookie: "sid=abcdef1234567890" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toMatch(/internal_error|at Object\.|node_modules/);
    await app.close();
  }, 60_000);

  it("redirects the operator to the wizard instead of erroring", async () => {
    // The pages behind the setup guard are redirected to /init — the
    // operator lands on the page that fixes the problem rather than on
    // a stack trace or a bare 404.
    const app = await buildServer(unreachableConfig());
    for (const url of ["/admin", "/login", "/dashboard"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe("/init");
    }
    await app.close();
  }, 60_000);

  it("reports the degraded state on /healthz", async () => {
    // A load balancer polling a server that cannot reach its database
    // must take it out of rotation — a 200 here would keep sending
    // traffic to a broken instance.
    const app = await buildServer(unreachableConfig());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("degraded");
    await app.close();
  }, 60_000);

  it("still serves the static assets the wizard needs", async () => {
    const app = await buildServer(unreachableConfig());
    const res = await app.inject({ method: "GET", url: "/assets/css/init.css" });
    expect(res.statusCode).toBe(200);
    await app.close();
  }, 60_000);

  it("says there is no .env yet on a fresh unpack", async () => {
    // The scratch directory has no .env — the state a fresh release-bundle
    // unpack is in. The hint under the form has to say the file will be
    // CREATED, not "your .env will be updated": the operator's next action
    // (do I need to copy .env.example first?) depends on it.
    const app = await buildServer(unreachableConfig());
    const res = await app.inject({ method: "GET", url: "/init/database" });
    expect(res.statusCode).toBe(200);
    // Default locale is zh-CN.
    expect(res.body).toMatch(/还没有 \.env|no \.env file yet/);
    await app.close();
  }, 60_000);
});

describe("the wizard configures the database", () => {
  it("rejects an empty host without touching anything", async () => {
    const app = await buildServer(unreachableConfig());
    const { agent, csrf } = await openWizard(app, "/init/database");

    const res = await agent.post("/init/database").type("form").send({
      csrf,
      host: "",
      port: "3306",
      user: "ipquery",
      password: "x",
      database: "ipquery",
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain("host");
    // Nothing was persisted — a rejected form must not half-write .env.
    expect(fs.existsSync(envFilePath())).toBe(false);
    await app.close();
  }, 60_000);

  it("rejects a nonsense port", async () => {
    const app = await buildServer(unreachableConfig());
    const { agent, csrf } = await openWizard(app, "/init/database");

    const res = await agent.post("/init/database").type("form").send({
      csrf,
      host: "127.0.0.1",
      port: "99999",
      user: "ipquery",
      password: "x",
      database: "ipquery",
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain("65535");
    expect(fs.existsSync(envFilePath())).toBe(false);
    await app.close();
  }, 60_000);

  it("does not persist credentials that cannot connect", async () => {
    const app = await buildServer(unreachableConfig());
    const { agent, csrf } = await openWizard(app, "/init/database");

    const res = await agent.post("/init/database").type("form").send({
      csrf,
      host: "127.0.0.1",
      port: String(DEAD_PORT),
      user: "ipquery",
      password: "wrong",
      database: "ipquery",
    });
    // The form comes back with an explanation...
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/refused|Could not connect|无法连接/);
    // ...and nothing was written. A .env that cannot connect is worse
    // than no .env, because the next boot dies on it with no way back.
    expect(fs.existsSync(envFilePath())).toBe(false);
    await app.close();
  }, 60_000);

  it("persists working credentials to .env", async () => {
    const cfg = loadConfig();
    const app = await buildServer(unreachableConfig());
    const { agent, csrf } = await openWizard(app, "/init/database");

    const res = await agent.post("/init/database").type("form").send({
      csrf,
      host: cfg.db.host,
      port: String(cfg.db.port),
      user: cfg.db.user,
      password: cfg.db.password,
      database: TARGET_DB,
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/init/site");

    // The .env now carries the connection, so the setting survives a
    // restart. The password is in there — .env is not committed.
    const written = fs.readFileSync(envFilePath(), "utf8");
    expect(written).toContain(`DB_HOST=${cfg.db.host}`);
    expect(written).toContain(`DB_PORT=${cfg.db.port}`);
    expect(written).toContain(`DB_USER=${cfg.db.user}`);
    expect(written).toContain(`DB_NAME=${TARGET_DB}`);
    expect(written).toContain(`DB_PASSWORD=${cfg.db.password}`);

    await app.close();
  }, 120_000);

  it("replaces existing DB_* lines instead of appending duplicates", async () => {
    // dotenv takes the FIRST occurrence of a key, so appending a second
    // DB_HOST= line would leave the effective value to a rule nobody
    // should have to reason about.
    fs.writeFileSync(
      envFilePath(),
      "NODE_ENV=production\nDB_HOST=old.example\nDB_PORT=1234\nDB_USER=old\nDB_PASSWORD=oldpw\nDB_NAME=olddb\nPORT=5001\n",
      "utf8",
    );

    const cfg = loadConfig();
    const app = await buildServer(unreachableConfig());
    const { agent, csrf } = await openWizard(app, "/init/database");

    await agent.post("/init/database").type("form").send({
      csrf,
      host: cfg.db.host,
      port: String(cfg.db.port),
      user: cfg.db.user,
      password: cfg.db.password,
      database: TARGET_DB,
    });

    const written = fs.readFileSync(envFilePath(), "utf8");
    expect(written.match(/^DB_HOST=/gm)?.length).toBe(1);
    expect(written.match(/^DB_PASSWORD=/gm)?.length).toBe(1);
    expect(written).toContain(`DB_HOST=${cfg.db.host}`);
    expect(written).not.toContain("old.example");
    // Unrelated keys survive.
    expect(written).toContain("PORT=5001");

    await app.close();
  }, 120_000);

  it("re-points the live pool and lifts the degraded gate", async () => {
    const cfg = loadConfig();
    const app = await buildServer(unreachableConfig());
    expect(app.dbDegraded).toBe(true);

    const { agent, csrf } = await openWizard(app, "/init/database");

    const res = await agent.post("/init/database").type("form").send({
      csrf,
      host: cfg.db.host,
      port: String(cfg.db.port),
      user: cfg.db.user,
      password: cfg.db.password,
      database: TARGET_DB,
    });
    expect(res.status).toBe(302);

    // The gate is lifted immediately — no restart.
    expect(app.dbDegraded).toBe(false);

    // The rest of the application answers normally now.
    const health = await agent.get("/healthz");
    expect(health.status).toBe(200);

    await app.close();
  }, 120_000);

  it("arms the ETL schedule only once the database is reachable", async () => {
    // The ETL schedule lives in the server, and it can only be armed when
    // there is a database to run an ETL against. Arming it at boot against
    // a dead pool would throw on every tick; never arming it would mean
    // the daily ETL silently never runs on an install that started without
    // a database. So: not armed while degraded, armed by the wizard.
    const cfg = loadConfig();
    const app = await buildServer(unreachableConfig());
    const { agent, csrf } = await openWizard(app, "/init/database");

    // Armed is observable through the scheduler's own decorators. While
    // the database is unreachable, starting it would be a mistake, so the
    // wizard is what calls it.
    let armedDuringWizard = false;
    const originalStart = app.startEtlScheduler;
    app.startEtlScheduler = () => {
      armedDuringWizard = true;
      originalStart();
    };

    await agent.post("/init/database").type("form").send({
      csrf,
      host: cfg.db.host,
      port: String(cfg.db.port),
      user: cfg.db.user,
      password: cfg.db.password,
      database: TARGET_DB,
    });

    // The wizard armed it as part of connecting.
    expect(armedDuringWizard).toBe(true);

    await app.close();
  }, 120_000);

  it("migrates the schema on the database it just connected to", async () => {
    const cfg = loadConfig();
    const app = await buildServer(unreachableConfig());
    const { agent, csrf } = await openWizard(app, "/init/database");

    await agent.post("/init/database").type("form").send({
      csrf,
      host: cfg.db.host,
      port: String(cfg.db.port),
      user: cfg.db.user,
      password: cfg.db.password,
      database: TARGET_DB,
    });

    // The wizard's later steps read tables (site.name, users, etl_runs).
    // Without the schema they would 500.
    const [rows] = await rootConn.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = ? AND table_name IN ('settings','users','ip_ranges','etl_runs')`,
      [TARGET_DB],
    );
    expect(Number((rows[0] as { n: number }).n)).toBe(4);

    await app.close();
  }, 120_000);

  it("the wizard can then be walked on to the next step", async () => {
    const cfg = loadConfig();
    const app = await buildServer(unreachableConfig());
    const { agent, csrf } = await openWizard(app, "/init/database");

    await agent.post("/init/database").type("form").send({
      csrf,
      host: cfg.db.host,
      port: String(cfg.db.port),
      user: cfg.db.user,
      password: cfg.db.password,
      database: TARGET_DB,
    });

    // Step 3 (site) reads settings from the database — it works now.
    const site = await agent.get("/init/site");
    expect(site.status).toBe(200);

    await app.close();
  }, 120_000);
});

describe("a server whose database works", () => {
  it("is not degraded and serves the application normally", async () => {
    const app = await buildServer(reachableConfig());
    expect(app.dbDegraded).toBe(false);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    await app.close();
  }, 60_000);
});

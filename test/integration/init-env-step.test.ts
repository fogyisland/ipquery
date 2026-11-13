// SPDX-License-Identifier: MIT
// Integration test: the wizard's step 2 (the .env step).
//
// Two things are pinned here, and both of them were broken.
//
// 1. There is no PORT FIELD. The port the Node process listens on is an
//    internal detail whenever a reverse proxy is in front — the operator
//    never types it. Having it editable invited the mistake that
//    actually happened: an operator entered the PUBLIC port (443),
//    which is the PROXY's port, not Node's.
//
// 2. The wizard ALWAYS advances. The step used to dead-end: when the
//    submitted port differed from the boot port, the handler
//    re-rendered the same page with a "restart needed" notice, so
//    clicking "generate and continue" brought back an identical page
//    with no forward path at all.
//
// It also pins that a page-level error does not leak into every form
// field: the `form-field` partial used to read a bare `{{#if error}}`,
// which Handlebars resolves against the PARENT context — so one notice
// appeared under every single field.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { buildServer } from "../../src/api/server";
import { isolateEnvFile, type EnvIsolation } from "../helpers/envIsolation";

const TEST_DB = "ipquery_test_init_env_step";

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

/** The CSRF token out of the rendered form, so a POST can be made. */
function extractCsrf(html: string): string {
  const m = /name="csrf" value="([^"]*)"/.exec(html);
  if (!m) throw new Error("csrf input not found in page");
  return m[1]!;
}

/**
 * GET the step-2 form and POST to it, threading the CSRF cookies
 * forward.
 *
 * The CSRF plugin wants three cookies (`csrf`, `csrf_issued`,
 * `csrf_bind`) plus the token from the form, so the GET and the POST
 * have to share a cookie jar — that is what a supertest agent gives.
 */
async function postEnvStep(
  agent: ReturnType<typeof request.agent>,
  fields: Record<string, string>,
): Promise<request.Response> {
  const page = await agent.get("/init/env").set("Host", "ip.example.com");
  const csrf = extractCsrf(page.text);
  return agent.post("/init/env").type("form").send({ csrf, ...fields });
}

beforeAll(async () => {
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

describe("step 2 has no port field", () => {
  it("offers no port input at all", async () => {
    const r = await request(app.server).get("/init/env").set("Host", "ip.example.com");
    expect(r.status).toBe(200);
    // A port input would invite the operator to type the proxy's port.
    expect(r.text).not.toMatch(/name="port"/);
    // The label must be gone too, not just the input.
    expect(r.text).not.toMatch(/监听端口/);
  });

  it("ignores a port that a stale form submits anyway", async () => {
    // An old bookmark or a cached tab can still submit a port. It must
    // not reach the .env — the running config is the authority.
    const agent = request.agent(app.server);
    const r = await postEnvStep(agent, {
      port: "8443",
      baseUrl: "https://ip.example.com",
    });
    expect(r.status).toBe(302);

    const written = fs.readFileSync(envIsolation!.file, "utf8");
    // The port in the .env is the one the process booted with, not 8443.
    expect(written).not.toContain("PORT=8443");
  });
});

describe("step 2 always advances", () => {
  it("redirects to the database step", async () => {
    const agent = request.agent(app.server);
    const r = await postEnvStep(agent, { baseUrl: "https://ip.example.com" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("/init/database");
  });

  it("does not dead-end when the .env holds a different port", async () => {
    // The hand-edited case: the .env says 8443, the process booted on
    // something else. The old handler re-rendered step 2 forever.
    fs.writeFileSync(
      envIsolation!.file,
      [
        "PORT=8443",
        "WEB_BASE_URL=http://localhost:3880",
        "SESSION_SECRET=keepme",
        "CSRF_SECRET=keepme",
      ].join("\n"),
      "utf8",
    );
    try {
      const agent = request.agent(app.server);
      const r = await postEnvStep(agent, { baseUrl: "https://ip.example.com" });
      // It must move FORWARD, not come back to the same step.
      expect(r.status).toBe(302);
      expect(r.headers.location).toContain("/init/database");
    } finally {
      fs.rmSync(envIsolation!.file, { force: true });
    }
  });

  it("shows the restart notice on the next step, not on step 2", async () => {
    // The notice has to survive the redirect, but as a notice — an
    // operator who sees it should understand they can carry on.
    fs.writeFileSync(
      envIsolation!.file,
      [
        "PORT=8443",
        "WEB_BASE_URL=http://localhost:3880",
        "SESSION_SECRET=keepme",
        "CSRF_SECRET=keepme",
      ].join("\n"),
      "utf8",
    );
    try {
      const agent = request.agent(app.server);
      const post = await postEnvStep(agent, { baseUrl: "https://ip.example.com" });
      const location = post.headers.location!;
      expect(location).toContain("/init/database");

      const next = await agent.get(location);
      expect(next.status).toBe(200);
      // The notice is rendered ONCE, as a notice.
      expect(next.text).toMatch(/重启|restart/);
      const occurrences = next.text.match(/重启服务后生效|for the change to take effect/g) ?? [];
      expect(occurrences.length).toBeLessThanOrEqual(1);
    } finally {
      fs.rmSync(envIsolation!.file, { force: true });
    }
  });
});

describe("a page-level error does not leak into every field", () => {
  it("repeats no message under the fields", async () => {
    // A base URL that fails validation renders a page-level error. That
    // error used to be repeated under EVERY form field, because the
    // partial read a bare `{{#if error}}` — which Handlebars resolves
    // against the parent context.
    const agent = request.agent(app.server);
    const r = await postEnvStep(agent, { baseUrl: "" });
    expect(r.status).toBe(400);

    // The error text appears in the page-level alert...
    const errors = r.text.match(/class="form-error"/g) ?? [];
    // ...exactly once, not once per field.
    expect(errors.length).toBe(1);
  });
});

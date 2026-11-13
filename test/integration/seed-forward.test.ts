// SPDX-License-Identifier: MIT
// Integration test: the seed step moves FORWARD once the import is done.
//
// The operator watched a 15-minute DB-IP import finish, saw "导入完成",
// and then found themselves back on the seed page — the step behaved as
// if it were still pending. Three defects sat behind that:
//
// 1. The `etl.setup.inProgress` setting gated the progress panel
//    alongside the run row's own status. The two were written by
//    different code paths (the wizard's background task vs. the ETL
//    pipeline), so they could disagree — and a server restart between
//    the two left the setting stuck at "true", stranding the operator
//    on a progress panel for a run that had finished. The run row is
//    the single source of truth now.
//
// 2. A SUCCESSFUL run did not advance. The GET handler only rendered
//    the progress panel while a run was in flight, so the moment the
//    import finished the page turned back into the three-option form —
//    which reads as "nothing happened" and invites the operator to run
//    the import again. A finished seed step now moves to the next one.
//
// 3. A run that failed BEFORE the pipeline could mark it (the download
//    throwing) left the row 'running' forever. The seed page reads that
//    row as "still importing", so the operator watched a spinner that
//    could never end and could never retry.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { buildServer } from "../../src/api/server";
import { getSetting, setSetting } from "../../src/storage/settings";
import { isolateEnvFile, type EnvIsolation } from "../helpers/envIsolation";

const TEST_DB = "ipquery_test_seed_forward";

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

function extractCsrf(html: string): string {
  const m = /name="csrf" value="([^"]*)"/.exec(html);
  if (!m) throw new Error("csrf input not found in page");
  return m[1]!;
}

/** Make the latest etl_runs row look a certain way. */
async function setRun(status: "running" | "success" | "failed", merged?: number): Promise<void> {
  await pool.query(`DELETE FROM etl_runs`);
  await pool.query(
    `INSERT INTO etl_runs (status, started_at, finished_at, merged_records, error_message)
     VALUES (?, NOW(3), ${status === "running" ? "NULL" : "NOW(3)"}, ?, ?)`,
    [
      status,
      merged ?? null,
      status === "failed" ? "the source files contained no usable records" : null,
    ],
  );
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

describe("the seed step moves forward once the import is done", () => {
  it("advances to the next step when the import succeeded", async () => {
    await setRun("success", 8942137);

    const r = await request(app.server).get("/init/seed");
    // The seed step is DONE — the operator lands on the summary, not
    // back on the page they just finished.
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("/init/complete");
  });

  it("records that the seed data was loaded", async () => {
    await setRun("success", 8942137);
    await request(app.server).get("/init/seed");
    expect(await getSetting(pool, "seed.loaded")).toBe("true");
  });

  it("does not advance while the import is still running", async () => {
    await setRun("running");

    const r = await request(app.server).get("/init/seed");
    expect(r.status).toBe(200);
    // The progress panel, with the auto-refresh that keeps it current.
    expect(r.text).toMatch(/setup-progress-status--running/);
    expect(r.text).toMatch(/http-equiv="refresh"/);
  });

  it("offers a retry when the import failed", async () => {
    await setRun("failed");

    const r = await request(app.server).get("/init/seed");
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/setup-progress-status--failed/);
    // The retry panel offers both ways forward.
    expect(r.text).toMatch(/value="demo"/);
    expect(r.text).toMatch(/value="etl"/);
  });

  it("ignores a stale inProgress flag left over from an old install", async () => {
    // The flag used to gate the progress panel. A server restart between
    // starting a run and finishing it left the flag at "true" forever.
    // The run row is the authority now — a stale flag cannot strand the
    // operator on a progress panel for a run that already finished.
    await setRun("success", 42);
    await setSetting(pool, "etl.setup.inProgress", "true");

    const r = await request(app.server).get("/init/seed");
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("/init/complete");
  });

  it("shows the choice form when no run has ever happened", async () => {
    await pool.query(`DELETE FROM etl_runs`);
    await setSetting(pool, "etl.setup.inProgress", "false");

    const r = await request(app.server).get("/init/seed");
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/value="etl"/);
    expect(r.text).toMatch(/value="demo"/);
    expect(r.text).toMatch(/value="skip"/);
  });

  it("moves forward on the demo path", async () => {
    const agent = request.agent(app.server);
    const page = await agent.get("/init/seed");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/seed").type("form").send({ csrf, mode: "demo" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("/init/complete");
    expect(await getSetting(pool, "seed.loaded")).toBe("true");
  });

  it("moves forward on the skip path", async () => {
    const agent = request.agent(app.server);
    const page = await agent.get("/init/seed");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/seed").type("form").send({ csrf, mode: "skip" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("/init/complete");
  });

  it("moves forward on the etl-done path, for a cached page", async () => {
    // An operator who had the old page open (with the 继续 button) can
    // still post it — the button is the same door as the auto-advance.
    const agent = request.agent(app.server);
    const page = await agent.get("/init/seed");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/seed").type("form").send({ csrf, mode: "etl-done" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("/init/complete");
    expect(await getSetting(pool, "seed.loaded")).toBe("true");
  });
});

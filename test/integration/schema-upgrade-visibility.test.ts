// SPDX-License-Identifier: MIT
//
// The two surfaces that answer "did the upgrade land?":
//
//  1. the boot log line — what a release upgrade looks like server-side
//  2. the overview card — what it looks like in the console
//
// Both exist because a migration that runs at boot and a migration that was
// already applied used to look identical: nothing was printed and the schema
// card said "up to date" either way. An operator copying a new build and
// restarting could not tell which had happened.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { listMigrationEntries, runMigrations, getSchemaReport } from "../../src/storage/migrations/runner";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("schema-upgrade-visibility");
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

describe("boot migration reporting", () => {
  it("returns the applied list on a fresh database and an empty one afterwards", async () => {
    // The boot path logs this shape. A fresh test database (createTestDb)
    // already ran the migrations, so a second run must report nothing applied
    // and every version skipped — that is the "up to date" case.
    const result = await runMigrations(td.pool);
    expect(result.applied).toEqual([]);
    const entries = await listMigrationEntries();
    expect(result.skipped.length).toBe(entries.length);

    // And with one version rolled back, exactly that version reports as applied.
    const newest = entries[entries.length - 1]!;
    await td.pool.query("DELETE FROM schema_migrations WHERE version = ?", [newest.version]);
    const afterRollback = await runMigrations(td.pool);
    expect(afterRollback.applied).toEqual([newest.version]);
    // The boot line's other half: how many were already present.
    expect(afterRollback.skipped.length).toBe(entries.length - 1);
  });
});

describe("overview schema card", () => {
  it("shows the newest applied migration when the database is current", async () => {
    const page = await request(app.server).get("/admin").set("Cookie", `sid=${adminSid}`);
    expect(page.status).toBe(200);
    const report = await getSchemaReport(app.pool);
    expect(report.isCurrent).toBe(true);
    // The card renders the applied version as `NNN_name`, and the status pill
    // says the schema is current rather than printing a bare count.
    expect(page.text).toContain(`${report.appliedLatest!.version}_${report.appliedLatest!.name}`);
    expect(page.text).not.toContain("NaN");
  });

  it("reports a pending migration instead of claiming the schema is current", async () => {
    // Roll the ledger back so the database is one step behind this build, then
    // read the page WITHOUT booting again — that is the state a half-copied
    // release leaves behind, and the card must say so rather than show a
    // stale "up to date".
    const entries = await listMigrationEntries();
    const newest = entries[entries.length - 1]!;
    await td.pool.query("DELETE FROM schema_migrations WHERE version = ?", [newest.version]);
    try {
      const page = await request(app.server).get("/admin").set("Cookie", `sid=${adminSid}`);
      expect(page.status).toBe(200);
      // The pending sentence names the newest step and the count.
      expect(page.text).toContain(`${newest.version}_${newest.name}`);
      expect(page.text).toMatch(/1\s*个迁移|1 migration/);
    } finally {
      // Restore for the rest of the suite.
      await runMigrations(td.pool);
    }
  });
});

// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import {
  recordEtlStart,
  recordEtlFinish,
  insertEtlRunDownload,
  insertEtlRunParse,
  insertEtlRunInsert,
  upsertEtlRunSwap,
} from "../../src/storage/mysql";
import { generateToken } from "../../src/web/auth/tokens";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let runningRunId: number;
let finishedRunId: number;

beforeAll(async () => {
  td = await createTestDb("etl-run-detail");
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

  // One finished run (success) with full stage row coverage.
  finishedRunId = await recordEtlStart(app.pool);
  await insertEtlRunDownload(app.pool, {
    runId: finishedRunId,
    source: "dbip-city",
    destName: "city",
    sourceUrl: "https://example.com/city.gz",
    month: "2026-08",
    status: "success",
    bytes: 1_234_567,
    durationMs: 1200,
    retryCount: 0,
    errorMessage: null,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  await insertEtlRunDownload(app.pool, {
    runId: finishedRunId,
    source: "dbip-country",
    destName: "country",
    sourceUrl: "https://example.com/country.gz",
    month: "2026-08",
    status: "success",
    bytes: 234_567,
    durationMs: 800,
    retryCount: 0,
    errorMessage: null,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  await insertEtlRunParse(app.pool, {
    runId: finishedRunId,
    source: "dbip-city",
    destName: "city",
    rowsEmitted: 8_300_000,
    rowsSkippedShort: 5,
    rowsSkippedHeader: 1,
    rowsSkippedUnparseableIp: 12,
    rowsSkippedMissingCol: 0,
    rowsSkippedNanAsn: 0,
    rowsSkippedOther: 2,
    gunzipErrors: 0,
    startedAt: new Date(),
    finishedAt: new Date(),
    durationMs: 4500,
  });
  await insertEtlRunInsert(app.pool, {
    runId: finishedRunId,
    source: "dbip-city",
    destName: "city",
    rowsAttempted: 8_300_020,
    rowsInserted: 8_300_000,
    rowsDuplicates: 20,
    batchCount: 9,
    durationMs: 7000,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  await upsertEtlRunSwap(app.pool, {
    runId: finishedRunId,
    status: "success",
    durationMs: 12,
    errorMessage: null,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  await recordEtlFinish(app.pool, finishedRunId, "success", { mergedRecords: 8_300_000 });

  // One still-running run (not finished) for the /live endpoint test.
  runningRunId = await recordEtlStart(app.pool);
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("admin /admin/etl/runs/:id", () => {
  it("renders full run detail with stage cards + per-file tables", async () => {
    const r = await request(app.server)
      .get("/admin/etl/runs/" + finishedRunId)
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    // zh-CN is the default locale, so the stage card titles are translated.
    expect(r.text).toContain("下载");
    expect(r.text).toContain("解析");
    expect(r.text).toContain("入库");
    expect(r.text).toContain("原子切换");
    // 4 stage cards
    const cardMatches = r.text.match(/class="etl-stage-card-title"/g) ?? [];
    expect(cardMatches.length).toBe(4);
    // Stage card values for the seeded run — parses emitted 8.3M rows, inserts attempted 8.3M.
    expect(r.text).toContain("8300000");
    // Status pill appears (success).
    expect(r.text).toMatch(/pill-success[^>]*>[^<]*成功/);
    // Per-file downloads table renders both city + country rows.
    expect(r.text).toContain("dbip-city");
    expect(r.text).toContain("dbip-country");
    // Parses table renders with skip-counters expandable.
    expect(r.text).toContain("etl-skip-details");
    // Inserts table renders batch_count column.
    expect(r.text).toContain("8300020");
    // Live polling trigger is present when status=running — but this
    // run is finished, so the trigger should NOT be in the DOM.
    expect(r.text).not.toContain('hx-trigger="every 5s"');
  });

  it("renders 404 when the run does not exist", async () => {
    const r = await request(app.server)
      .get("/admin/etl/runs/9999999")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(404);
  });

  it("non-admin is blocked", async () => {
    const user = await createUser(app.pool, {
      email: "u@x.com",
      passwordHash: "h",
      displayName: "U",
    });
    const userSid = generateToken(16);
    await createSession(app.pool, userSid, user.id, new Date(Date.now() + 3600_000));
    const r = await request(app.server)
      .get("/admin/etl/runs/" + finishedRunId)
      .set("Cookie", "sid=" + userSid);
    // 404, not 403: the auth guard answers a non-admin /admin/* request
    // with "not found" so the admin console is not a free directory
    // listing for every registered user (see src/web/plugins/auth.ts).
    expect(r.status).toBe(404);
  });
});

describe("admin /admin/etl/runs/:id/live", () => {
  it("returns 200 with bare section wrapper while run is still running", async () => {
    const r = await request(app.server)
      .get("/admin/etl/runs/" + runningRunId + "/live")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toContain('class="etl-stage-live"');
    // Header pill row is suppressed in liveOnly mode to avoid flicker.
    expect(r.text).not.toContain('class="etl-run-header"');
    // The live partial must NOT carry its own trigger — otherwise swapping
    // it in would re-arm polling indefinitely.
    expect(r.text).not.toContain('hx-trigger="every 5s"');
  });

  it("returns 204 when the run has finished", async () => {
    const r = await request(app.server)
      .get("/admin/etl/runs/" + finishedRunId + "/live")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(204);
  });

  it("returns 204 when the run does not exist", async () => {
    const r = await request(app.server)
      .get("/admin/etl/runs/9999999/live")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(204);
  });

  it("non-admin is blocked", async () => {
    const user = await createUser(app.pool, {
      email: "u2@x.com",
      passwordHash: "h",
      displayName: "U2",
    });
    const userSid = generateToken(16);
    await createSession(app.pool, userSid, user.id, new Date(Date.now() + 3600_000));
    const r = await request(app.server)
      .get("/admin/etl/runs/" + runningRunId + "/live")
      .set("Cookie", "sid=" + userSid);
    // 404, not 403 — same anti-enumeration rule as the detail route.
    expect(r.status).toBe(404);
  });
});

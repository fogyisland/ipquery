// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { insertQueryLogs, listQueryLogs, countQueriesByStatusSince } from "../../src/storage/queryLog";
import { parseIp } from "../../src/ip";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("querylog");
});
afterAll(async () => {
  await dropTestDb(td);
});

describe("query_log", () => {
  it("insert + list round-trip", async () => {
    const buf = parseIp("8.8.8.8")!;
    await insertQueryLogs(td.pool, [
      {
        ip: buf,
        ipText: "8.8.8.8",
        status: "hit",
        userId: null,
        apiKeyId: null,
        sessionId: null,
        remoteAddr: buf,
        userAgent: "test",
      },
    ]);
    const r = await listQueryLogs(td.pool, { offset: 0, limit: 10 });
    expect(r.total).toBe(1);
    expect(r.rows[0]?.ipText).toBe("8.8.8.8");
    expect(r.rows[0]?.status).toBe("hit");
  });

  it("listQueryLogs filter by status", async () => {
    await insertQueryLogs(td.pool, [
      {
        ip: parseIp("1.1.1.1")!,
        ipText: "1.1.1.1",
        status: "invalid",
        userId: null,
        apiKeyId: null,
        sessionId: null,
        remoteAddr: null,
        userAgent: null,
      },
      {
        ip: parseIp("2.2.2.2")!,
        ipText: "2.2.2.2",
        status: "miss",
        userId: null,
        apiKeyId: null,
        sessionId: null,
        remoteAddr: null,
        userAgent: null,
      },
    ]);
    const r = await listQueryLogs(td.pool, { offset: 0, limit: 10, status: "invalid" });
    expect(r.rows.every((x) => x.status === "invalid")).toBe(true);
  });

  it("countQueriesByStatusSince", async () => {
    const counts = await countQueriesByStatusSince(td.pool, new Date(Date.now() - 60_000));
    expect(counts.invalid).toBeGreaterThanOrEqual(1);
    expect(counts.miss).toBeGreaterThanOrEqual(1);
    expect(counts.hit).toBeGreaterThanOrEqual(1);
  });

  it("countQueriesByStatusSince with userId isolates per-user counts", async () => {
    // Pre-MVP parked: /dashboard used to show every user's hit/miss/invalid
    // counts (no userId filter on countQueriesByStatusSince) — leaked other
    // users' query volume + hit rate. Verify userId scoping works.
    const ua = parseIp("10.0.0.1")!;
    const ub = parseIp("10.0.0.2")!;
    const since = new Date(Date.now() - 60_000);
    await insertQueryLogs(td.pool, [
      {
        ip: ua,
        ipText: "10.0.0.1",
        status: "hit",
        userId: 7001,
        apiKeyId: null,
        sessionId: null,
        remoteAddr: null,
        userAgent: null,
      },
      {
        ip: ua,
        ipText: "10.0.0.1",
        status: "hit",
        userId: 7001,
        apiKeyId: null,
        sessionId: null,
        remoteAddr: null,
        userAgent: null,
      },
      {
        ip: ub,
        ipText: "10.0.0.2",
        status: "miss",
        userId: 7002,
        apiKeyId: null,
        sessionId: null,
        remoteAddr: null,
        userAgent: null,
      },
    ]);
    const aCounts = await countQueriesByStatusSince(td.pool, since, { userId: 7001 });
    const bCounts = await countQueriesByStatusSince(td.pool, since, { userId: 7002 });
    expect(aCounts.hit).toBeGreaterThanOrEqual(2);
    expect(aCounts.miss).toBe(0);
    expect(bCounts.hit).toBe(0);
    expect(bCounts.miss).toBeGreaterThanOrEqual(1);
  });

  it("large batch chunks at 200", async () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({
      ip: parseIp("127.0.0.1")!,
      ipText: `127.0.0.${i % 256}`,
      status: "miss" as const,
      userId: null,
      apiKeyId: null,
      sessionId: null,
      remoteAddr: null,
      userAgent: null,
    }));
    await insertQueryLogs(td.pool, entries);
    const r = await listQueryLogs(td.pool, { offset: 0, limit: 1000 });
    expect(r.total).toBeGreaterThanOrEqual(250);
  });

  it("rejects a sort column outside the allow-list", async () => {
    // `col` is interpolated into the ORDER BY clause, so the storage
    // layer validates it even though the TypeScript type already
    // restricts it. This guards against a future caller passing an
    // unvalidated string.
    await expect(
      listQueryLogs(td.pool, {
        offset: 0,
        limit: 10,
        sort: { col: "id; DROP TABLE query_log" as "id", dir: "asc" },
      }),
    ).rejects.toThrow(/unsupported sort column/);
  });

  it("accepts both allow-listed sort columns", async () => {
    const byId = await listQueryLogs(td.pool, { offset: 0, limit: 5, sort: { col: "id", dir: "desc" } });
    const byTs = await listQueryLogs(td.pool, { offset: 0, limit: 5, sort: { col: "ts", dir: "asc" } });
    expect(byId.total).toBeGreaterThan(0);
    expect(byTs.total).toBeGreaterThan(0);
  });
});

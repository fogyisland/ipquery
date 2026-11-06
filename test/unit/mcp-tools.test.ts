// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { mcpLookup, lookupToolDef, clampInt, mcpQueueStats, mcpEtlStatus, queueStatsToolDef, etlStatusToolDef, queueTopToolDef, type McpPool } from "../../src/mcp/tools";

const noopLog = { warn: vi.fn(), error: vi.fn() };

function makeDeps(pool: unknown): McpPool {
  return { pool: pool as never, log: noopLog };
}

describe("mcpLookup", () => {
  it("rejects invalid ip without touching the pool", async () => {
    const pool = { query: vi.fn() };
    await expect(mcpLookup(makeDeps(pool), "999.1.1.1")).rejects.toMatchObject({ code: "invalid_ip" });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("lookupToolDef", () => {
  it("marks ip required in the JSON schema", () => {
    const def = lookupToolDef();
    expect(def.name).toBe("ipquery_lookup");
    expect((def.inputSchema as { required?: string[] }).required).toContain("ip");
  });
});

describe("clampInt", () => {
  it("clamps out-of-range and non-numeric values", () => {
    expect(clampInt("500", 1, 100, 20)).toBe(100);
    expect(clampInt(0, 1, 100, 20)).toBe(1);
    expect(clampInt("abc", 1, 100, 20)).toBe(20);
    expect(clampInt(undefined, 1, 100, 20)).toBe(20);
  });
});

describe("mcpQueueStats", () => {
  it("returns the queueStats triple", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue([[{ pending: 3, processed: 9, total_queries: 12 }], []]),
    };
    const stats = await mcpQueueStats(makeDeps(pool));
    expect(stats).toEqual({ pending: 3, processed: 9, totalQueries: 12 });
  });
  it("surface failures with context instead of bare throws", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("boom")) };
    await expect(mcpQueueStats(makeDeps(pool))).rejects.toThrow("queue stats failed");
    expect(noopLog.error).toHaveBeenCalled();
  });
});

describe("mcpEtlStatus", () => {
  it("serializes the last ETL run with ISO dates and queue summary", async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce([
          [
            {
              id: 14,
              started_at: new Date("2026-11-05T02:00:00Z"),
              finished_at: new Date("2026-11-05T02:30:00Z"),
              status: "success",
              merged_records: 8940000,
              maxmind_records: 0,
              ip2region_records: 0,
              dbip_records: 8940000,
            },
          ],
          [],
        ])
        .mockResolvedValueOnce([[{ pending: 1, processed: 2, total_queries: 3 }], []]),
    };
    const res = await mcpEtlStatus(makeDeps(pool));
    expect(res.lastRun).not.toBeNull();
    expect((res.lastRun as { status: string }).status).toBe("success");
    expect((res.lastRun as { startedAt: string }).startedAt).toBe("2026-11-05T02:00:00.000Z");
    expect(res.queue).toEqual({ pending: 1, processed: 2, totalQueries: 3 });
  });
  it("returns null lastRun when the table is empty", async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ pending: null, processed: null, total_queries: 0 }], []]),
    };
    const res = await mcpEtlStatus(makeDeps(pool));
    expect(res.lastRun).toBeNull();
    expect(res.queue).toEqual({ pending: 0, processed: 0, totalQueries: 0 });
  });
});

describe("tool defs", () => {
  it("expose the queue and etl tool names", () => {
    expect(queueStatsToolDef().name).toBe("ipquery_queue_stats");
    expect(queueTopToolDef().name).toBe("ipquery_queue_top");
    expect(etlStatusToolDef().name).toBe("ipquery_etl_status");
    expect(queueTopToolDef().inputSchema.properties).toHaveProperty("limit");
  });
});

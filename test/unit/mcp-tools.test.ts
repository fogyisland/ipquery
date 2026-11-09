// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import {
  mcpLookup,
  lookupToolDef,
  clampInt,
  mcpQueueStats,
  mcpEtlStatus,
  queueStatsToolDef,
  etlStatusToolDef,
  queueTopToolDef,
  maskEmail,
  maskPrefix,
  sanitizeQueryRow,
  mcpQueriesRecent,
  mcpQueriesDaily,
  queriesRecentToolDef,
  queriesDailyToolDef,
  type McpPool,
} from "../../src/mcp/tools";

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

describe("masking", () => {
  it("masks email and api-key prefix", () => {
    expect(maskEmail("peng@example.com")).toBe("p***@e***.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskPrefix("abcd1234")).toBe("abcd***");
    expect(maskPrefix(null)).toBeNull();
  });
  it("handles short inputs without crashing", () => {
    expect(maskEmail("a@b.c")).toBe("a***@b***.c");
    expect(maskPrefix("ab")).toBe("ab***");
    expect(maskEmail("")).toBeNull();
    expect(maskPrefix("")).toBeNull();
  });
  it("does not leak subdomains — only the TLD survives", () => {
    // Regression: the mask used to split on the FIRST dot, so a
    // subdomain address rendered as a***@m***.example.com — leaking the
    // full registrable domain. Only the TLD may survive.
    expect(maskEmail("a@mail.example.com")).toBe("a***@m***.com");
    expect(maskEmail("peng@dept.corp.example.co.uk")).toBe("p***@d***.uk");
  });
});

describe("sanitizeQueryRow", () => {
  const row = {
    id: 1,
    ts: new Date("2026-11-05T00:00:00Z"),
    ipText: "1.2.3.4",
    status: "hit",
    userEmail: "peng@example.com",
    apiKeyPrefix: "abcd1234",
    userAgent: "curl/8",
  } as never;
  it("redacts by default", () => {
    const r = sanitizeQueryRow(row, false) as Record<string, unknown>;
    expect(r.userEmail).toBe("p***@e***.com");
    expect(r.apiKeyPrefix).toBe("abcd***");
    expect(r.ipText).toBe("1.2.3.4");
  });
  it("reveals originals with includePrivate", () => {
    const r = sanitizeQueryRow(row, true) as Record<string, unknown>;
    expect(r.userEmail).toBe("peng@example.com");
    expect(r.apiKeyPrefix).toBe("abcd1234");
  });
});

describe("mcpQueriesRecent", () => {
  it("redacts rows by default and clamps limit", async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValue([
          [
            {
              id: 1,
              ts: new Date(),
              ip_text: "1.2.3.4",
              status: "hit",
              user_email: "peng@example.com",
              api_key_prefix: "abcd1234",
            },
          ],
          [{ total: 1 }],
        ]),
    };
    const res = await mcpQueriesRecent(makeDeps(pool), { limit: 500 });
    const first = res.rows[0] as Record<string, unknown>;
    expect(first.userEmail).toBe("p***@e***.com");
    expect(first.apiKeyPrefix).toBe("abcd***");
    expect(pool.query).toHaveBeenCalledWith(expect.anything(), [50, 0]);
  });
  it("passes status filter through", async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ c: 0 }], []]),
    };
    await mcpQueriesRecent(makeDeps(pool), { status: "miss" });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status = ?"), expect.anything());
  });
});

describe("query-log tool defs", () => {
  it("expose names and enum-restricted status", () => {
    expect(queriesRecentToolDef().name).toBe("ipquery_queries_recent");
    expect(queriesDailyToolDef().name).toBe("ipquery_queries_daily");
    const props = queriesRecentToolDef().inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.status?.enum).toEqual(["hit", "miss", "invalid"]);
  });
});

describe("mcpQueriesDaily", () => {
  it("sums each day's buckets into a single count", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue([
        [
          { d: "2026-11-08", status: "hit", c: 3 },
          { d: "2026-11-08", status: "miss", c: 1 },
          { d: "2026-11-09", status: "invalid", c: 2 },
        ],
        [],
      ]),
    };
    const res = await mcpQueriesDaily(makeDeps(pool), { days: 2 });
    expect(res).toEqual([
      { day: "2026-11-08", count: 4 },
      { day: "2026-11-09", count: 2 },
    ]);
    // The `since` bound and every day key are UTC — the SQL buckets on a
    // converted-to-UTC DATE, and the WHERE bound is a UTC midnight.
    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("CONVERT_TZ");
    expect((params[0] as Date).toISOString()).toMatch(/T00:00:00\.000Z$/);
  });
  it("clamps days and emits exactly that many buckets", async () => {
    const pool = { query: vi.fn().mockResolvedValue([[], []]) };
    const res = await mcpQueriesDaily(makeDeps(pool), { days: 500 });
    expect(res).toHaveLength(90);
  });
  it("maps a pool failure to a typed error", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("boom")) };
    await expect(mcpQueriesDaily(makeDeps(pool), {})).rejects.toThrow("daily queries failed: boom");
  });
});

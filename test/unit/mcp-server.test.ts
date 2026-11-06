// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { buildToolRegistrations } from "../../src/mcp/server-tools";
import { TOOL_NAMES } from "../../src/mcp/tool-names";

const noopLog = { warn: vi.fn(), error: vi.fn() };

describe("buildToolRegistrations", () => {
  it("registers exactly the 7 read-only tools", () => {
    const deps = { pool: {}, log: noopLog } as never;
    const tools = buildToolRegistrations(deps);
    expect(tools.map((t) => t.def.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES).toHaveLength(7);
  });

  it("includes ipquery_stats as a top-level tool", () => {
    const tools = buildToolRegistrations({ pool: {}, log: noopLog } as never);
    const stats = tools.find((t) => t.def.name === "ipquery_stats");
    expect(stats).toBeDefined();
  });

  it("handler errors become structured results, not throws", async () => {
    const deps = {
      pool: { query: vi.fn().mockRejectedValue(new Error("boom")) },
      log: noopLog,
    } as never;
    const tools = buildToolRegistrations(deps);
    const etl = tools.find((t) => t.def.name === "ipquery_etl_status")!;
    const res = await etl.handler({});
    expect(res.isErrorHint).toBe(true);
    expect(res.message).toContain("etl status failed");
  });

  it("lookup rejects an invalid ip with structured output", async () => {
    const tools = buildToolRegistrations({ pool: { query: vi.fn() }, log: noopLog } as never);
    const lookup = tools.find((t) => t.def.name === "ipquery_lookup")!;
    const res = await lookup.handler({ ip: "999.9.9.9" });
    expect(res.isErrorHint).toBe(true);
    expect(res.message).toContain("invalid ip");
  });

  it("rejects unknown tool names", async () => {
    const tools = buildToolRegistrations({ pool: {}, log: noopLog } as never);
    const bad = tools.find((t) => t.def.name === "ipquery_no_such_tool");
    expect(bad).toBeUndefined();
  });
});

describe("handler error typing", () => {
  it("flags tool failures via a typed isErrorHint field, not string matching", async () => {
    const deps = {
      pool: { query: vi.fn().mockRejectedValue(new Error("boom")) },
      log: noopLog,
    } as never;
    const tools = buildToolRegistrations(deps);
    const etl = tools.find((t) => t.def.name === "ipquery_etl_status")!;
    // The handler result itself must carry the typed flag; the server layer
    // must not sniff serialized text to detect errors. Guard: the flag stays
    // detectable no matter how the JSON is formatted.
    const result = await etl.handler({});
    expect(result.isErrorHint).toBe(true);
    expect(typeof result.message).toBe("string");
    expect(JSON.stringify(result).replace(/\s+/g, "")).toContain('"isErrorHint":true');
  });
});

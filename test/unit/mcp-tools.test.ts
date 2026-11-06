// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { mcpLookup, lookupToolDef, type McpPool } from "../../src/mcp/tools";

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

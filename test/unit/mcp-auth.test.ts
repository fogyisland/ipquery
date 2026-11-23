// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach } from "vitest";
import { authenticate, LOOKUP_SCOPE_TOOLS, OPS_SCOPE_TOOLS } from "../../src/mcp/auth";
import { TOOL_NAMES } from "../../src/mcp/tool-names";
import { hashToken } from "../../src/web/auth/tokens";
import type { McpToken } from "../../src/types";

const PLAINTEXT = "ipqt_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function makeToken(overrides: Partial<McpToken> = {}): McpToken {
  return {
    id: 1,
    userId: 7,
    label: "cursor",
    tokenPrefix: "ipqt_ABCDEF",
    status: "approved",
    scope: "lookup",
    requestedAt: new Date("2026-11-14T00:00:00Z"),
    decidedAt: new Date("2026-11-14T01:00:00Z"),
    decidedBy: 1,
    decisionNote: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date("2026-11-14T00:00:00Z"),
    ...overrides,
  };
}

/** A pool stub whose lookup returns the given token (or null). */
function poolWith(token: McpToken | null) {
  return {
    query: vi.fn().mockResolvedValue(token ? [[token]] : [[]]),
  } as never;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("authenticate", () => {
  it("refuses to start when a token is required but absent", async () => {
    await expect(authenticate(poolWith(null), undefined, true)).rejects.toThrow(
      /MCP_REQUIRE_TOKEN is enabled/,
    );
  });

  it("refuses a token that is not approved", async () => {
    // The storage lookup only ever returns an approved, non-revoked
    // token — so a rejected request surfaces as "unknown token" here.
    await expect(authenticate(poolWith(null), PLAINTEXT, true)).rejects.toThrow(
      /MCP token rejected/,
    );
  });

  it("authenticates an approved token and exposes only its scope's tools", async () => {
    const auth = await authenticate(poolWith(makeToken({ scope: "lookup" })), PLAINTEXT, true);
    expect(auth.mode).toBe("token");
    expect(auth.scope).toBe("lookup");
    expect([...auth.allowedTools].sort()).toEqual([...LOOKUP_SCOPE_TOOLS].sort());
    // The operational tools must be invisible to a lookup-scoped token.
    expect(auth.allowedTools.has("ipquery_queries_recent")).toBe(false);
    expect(auth.allowedTools.has("ipquery_queue_stats")).toBe(false);
  });

  it("grants every tool to an ops-scoped token", async () => {
    const auth = await authenticate(poolWith(makeToken({ scope: "ops" })), PLAINTEXT, true);
    expect(auth.scope).toBe("ops");
    expect([...auth.allowedTools].sort()).toEqual([...OPS_SCOPE_TOOLS].sort());
    expect(auth.allowedTools.size).toBe(OPS_SCOPE_TOOLS.length);
  });

  it("runs unauthenticated in local mode when no token is supplied", async () => {
    const auth = await authenticate(poolWith(null), undefined, false);
    expect(auth.mode).toBe("local");
    expect(auth.token).toBeNull();
    expect(auth.allowedTools.size).toBe(OPS_SCOPE_TOOLS.length);
  });

  it("treats a blank token as absent", async () => {
    const auth = await authenticate(poolWith(null), "   ", false);
    expect(auth.mode).toBe("local");
  });

  it("looks the token up by hash, never by plaintext", async () => {
    const query = vi.fn().mockResolvedValue([[makeToken()]]);
    await authenticate({ query } as never, PLAINTEXT, true);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("token_hash = ?");
    expect(params).toEqual([hashToken(PLAINTEXT)]);
    // The plaintext must never reach the database.
    expect(JSON.stringify(params)).not.toContain(PLAINTEXT);
  });

  it("stamps the token's last use without failing the call when the stamp fails", async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT * FROM mcp_tokens")) return Promise.resolve([[makeToken()]]);
      return Promise.reject(new Error("write failed"));
    });
    const auth = await authenticate({ query } as never, PLAINTEXT, true);
    expect(auth.mode).toBe("token");
  });
});

describe("tool scope boundaries", () => {
  it("the lookup scope contains only the geolocation tools", () => {
    // Batch lookup is the same operation as lookup, so it belongs
    // here. Nothing operational may creep in.
    expect([...LOOKUP_SCOPE_TOOLS].sort()).toEqual([
      "ipquery_lookup",
      "ipquery_lookup_batch",
    ]);
    for (const name of LOOKUP_SCOPE_TOOLS) {
      expect(name).toMatch(/^ipquery_lookup/);
    }
  });

  it("the ops scope contains the lookup tool too", () => {
    expect(OPS_SCOPE_TOOLS).toContain("ipquery_lookup");
  });

  it("the ops scope covers every tool the server registers", () => {
    // A new tool that is not listed in the ops scope would silently be
    // unreachable for every token — the exact failure this catches.
    //
    // The count is derived from the canonical list, not written down:
    // a hardcoded number here would fail the moment a tool is added,
    // which is a nuisance rather than a signal. What matters is that
    // the two lists agree.
    expect(new Set(OPS_SCOPE_TOOLS).size).toBe(OPS_SCOPE_TOOLS.length);
    expect([...OPS_SCOPE_TOOLS].sort()).toEqual([...TOOL_NAMES].sort());
  });
});

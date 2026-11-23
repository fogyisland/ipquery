// SPDX-License-Identifier: MIT
//
// The documentation must say which scope each tool belongs to.
//
// `docs/mcp.md` carries a table with a "权限范围" (scope) column. That
// column is what an operator reads before deciding which token to
// mint: the whole point of the narrow `lookup` scope is that it
// cannot read the audit log, the provider health, or the queue — and
// the audit log carries operator email addresses.
//
// The tool *count* is already guarded (see mcp-docs-tool-count.test.ts),
// but the count being right says nothing about the scope column. A
// row that claims `ipquery_audit_log` is `lookup`-scoped would let
// somebody mint the narrow token and expect to read the audit log, and
// would be silently wrong.
//
// These tests read the scope column out of the table and check it
// against the scope lists the server enforces.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TOOL_NAMES } from "../../src/mcp/tool-names";
import { OPS_SCOPE_TOOLS, LOOKUP_SCOPE_TOOLS } from "../../src/mcp/auth";

const root = path.resolve(__dirname, "..", "..");

/**
 * Which scopes the table says can reach a tool.
 *
 * "全部" means every scope reaches it; "ops" means only the ops
 * scope does. The question the table answers is not "what label does
 * this tool carry" but "which token do I have to mint to use it" —
 * and a tool documented as "全部" that only ops can reach is a false
 * claim that would have somebody mint the narrow token and expect it
 * to work.
 *
 * An unrecognized cell is a failure, not a skip: a row in a table
 * that documents a security boundary has to be judgeable.
 */
function claimedScopes(scopeCell: string): Set<"lookup" | "ops"> {
  const cell = scopeCell.trim();
  if (cell === "ops") return new Set(["ops"]);
  if (cell === "全部" || cell === "all") return new Set(["lookup", "ops"]);
  throw new Error(`unrecognized scope cell: ${JSON.stringify(cell)}`);
}

/** Which scopes the server actually enforces for a tool. */
function enforcedScopes(tool: string): Set<"lookup" | "ops"> {
  const scopes = new Set<"lookup" | "ops">();
  if ((LOOKUP_SCOPE_TOOLS as readonly string[]).includes(tool)) scopes.add("lookup");
  if ((OPS_SCOPE_TOOLS as readonly string[]).includes(tool)) scopes.add("ops");
  if (scopes.size === 0) {
    throw new Error(`${tool} is in no scope list — it would be unreachable`);
  }
  return scopes;
}

describe("The MCP scope column in docs/mcp.md", () => {
  const doc = fs.readFileSync(path.join(root, "docs", "mcp.md"), "utf8");

  /** Every table row that names a tool: [tool, scope cell]. */
  const rows: Array<[string, string]> = [];
  for (const line of doc.split(/\r?\n/)) {
    // The tool name is matched loosely on purpose: a future tool whose
    // name carries a digit or a hyphen must still be found, or the
    // row would be skipped and the scope of a real tool would go
    // unchecked.
    const match = line.match(/^\|\s*`(ipquery_[a-z0-9_-]+)`\s*\|\s*([^|]*?)\s*\|/);
    if (match) rows.push([match[1]!, match[2]!]);
  }

  it("documents every tool the server registers", () => {
    expect(rows.length, "docs/mcp.md has no tool table").toBeGreaterThan(0);
    const documented = rows.map(([name]) => name).sort();
    expect(documented).toEqual([...TOOL_NAMES].sort());
  });

  it("claims the scope the server enforces for every tool", () => {
    for (const [name, scopeCell] of rows) {
      const claimed = claimedScopes(scopeCell);
      const enforced = enforcedScopes(name);
      // The sets have to be equal, not merely overlapping: a tool
      // documented as reachable by more scopes than it is would send
      // an operator to mint a token that still cannot reach it.
      expect([...claimed].sort(), `${name} is documented as ${scopeCell}`).toEqual(
        [...enforced].sort(),
      );
    }
  });

  it("keeps the ops-only tools out of the narrow scope", () => {
    // The narrow `lookup` scope is the one an operator hands to a
    // client that only needs geolocation. A tool that leaks operator
    // identity into that scope defeats the point of having two.
    const narrow = new Set<string>(LOOKUP_SCOPE_TOOLS);
    for (const name of narrow) {
      // Every lookup-scoped tool is also an ops-scoped one, so the
      // enforced scope of a lookup tool is "ops" — the narrower list
      // is what restricts it, not the scope labels.
      expect(OPS_SCOPE_TOOLS as readonly string[]).toContain(name);
    }
    // The audit log carries operator email addresses — it must never
    // be reachable by a lookup-scoped token.
    expect(narrow.has("ipquery_audit_log")).toBe(false);
    // The query log carries user emails and API key prefixes.
    expect(narrow.has("ipquery_queries_recent")).toBe(false);
  });
});

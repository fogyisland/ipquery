// SPDX-License-Identifier: MIT
//
// The documentation must agree with the tool list.
//
// The MCP server's tool count was written into six documents by hand:
// "7 个工具" in docs/mcp.md (four times), "7 工具全开" in
// docs/source-deploy.md and up/README.md, "全部 7 个" in
// docs/setup.md, and "all seven tools" in README.md.
//
// A hand-written count is the same kind of promise as a hand-written
// source list: it stops being true the moment a tool is added, and
// nothing fails. The count drifted once already — the tool list grew
// while the prose did not.
//
// These tests read the tool list and the documents, and check they
// agree. A new tool now breaks the build rather than leaving the docs
// quietly wrong.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TOOL_NAMES } from "../../src/mcp/tool-names";
import { OPS_SCOPE_TOOLS, LOOKUP_SCOPE_TOOLS } from "../../src/mcp/auth";

const root = path.resolve(__dirname, "..", "..");

const toolCount = TOOL_NAMES.length;

function readDoc(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * The count a document states, in whichever way it states it.
 *
 * Every number a document attaches to the word "工具" / "tools" is
 * the total: the ops scope reaches every tool, so a document has no
 * reason to state a subset count. A document that names a subset
 * ("6 of the tools read operational data") is a hand-written count
 * waiting to drift, and the sentence it sits in is the thing to
 * avoid — not something to encode here.
 */
function statedCounts(text: string): number[] {
  const found: number[] = [];
  // Chinese phrasing: "8 个工具", "8 工具全开", "全部 8 个"
  for (const match of text.matchAll(/(\d+)\s*个?\s*工具/g)) {
    found.push(Number(match[1]));
  }
  // English phrasing: "all eight tools", "8 read-only tools"
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  for (const match of text.matchAll(
    /\b(all\s+)?(one|two|three|four|five|six|seven|eight|nine|ten)\b[^.]{0,20}?\btools?\b/gi,
  )) {
    found.push(words[match[2]!.toLowerCase()]!);
  }
  for (const match of text.matchAll(/\b(\d+)\s+(read-only\s+)?tools?\b/gi)) {
    found.push(Number(match[1]));
  }
  return found;
}

describe("The MCP tool count in the documentation", () => {
  it("is the number of tools the server actually registers", () => {
    expect(toolCount).toBeGreaterThan(0);
    // Every canonical name is unique — a duplicate would make the
    // count wrong without making the list look wrong.
    expect(new Set(TOOL_NAMES).size).toBe(toolCount);
  });

  it("is the number of ops-scoped tools the server actually registers", () => {
    // The ops scope reaches every tool, including the lookup: an
    // ops-scoped token is the "read everything" credential. The
    // lookup scope is the narrow one — `ipquery_lookup` alone.
    expect(OPS_SCOPE_TOOLS.length).toBe(toolCount);
    expect(new Set(OPS_SCOPE_TOOLS).size).toBe(OPS_SCOPE_TOOLS.length);
    // The lookup scope is the narrow one: the geolocation tools and
    // nothing operational. The count is derived, not written down —
    // what matters is that every lookup tool is also an ops tool.
    expect(LOOKUP_SCOPE_TOOLS.length).toBeGreaterThan(0);
    for (const name of LOOKUP_SCOPE_TOOLS) {
      expect(OPS_SCOPE_TOOLS as readonly string[]).toContain(name);
    }
  });

  const documents = [
    "docs/mcp.md",
    "README.md",
    "docs/setup.md",
    "docs/source-deploy.md",
    "up/README.md",
  ];

  for (const document of documents) {
    it(`matches what ${document} says`, () => {
      const text = readDoc(document);
      const counts = statedCounts(text);
      expect(counts.length, `${document} states no tool count`).toBeGreaterThan(0);
      for (const count of counts) {
        expect(count, `${document} says ${count} tools, the server has ${toolCount}`).toBe(
          toolCount,
        );
      }
    });
  }
});

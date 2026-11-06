// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { resolveProjectRoot } from "../../src/mcp/env";

describe("resolveProjectRoot", () => {
  it("returns a directory that contains package.json", () => {
    const root = resolveProjectRoot();
    expect(require("node:fs").existsSync(require("node:path").join(root, "package.json"))).toBe(true);
  });
});

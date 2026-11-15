// SPDX-License-Identifier: MIT
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Locate the project root by walking up from this module until a
 * directory containing `package.json` is found.
 *
 * A fixed number of `..` hops would be brittle: the source lives in
 * `src/paths.ts` (one hop) while the build output lives in
 * `dist/paths.js` (one hop) — but `src/mcp/env.ts` and `dist/mcp/env.js`
 * are two hops down, so a single constant cannot serve every caller.
 * Searching for the manifest works from any depth and from any
 * directory layout.
 *
 * The walk stops at the filesystem root; if no manifest is found the
 * caller gets a path that does not exist, which fails loudly at use
 * time rather than silently pointing somewhere else.
 */
export function resolveProjectRoot(): string {
  let dir = __dirname;
  // Bounded walk: the root of a drive is at most a handful of levels
  // below any project, and the bound stops a broken symlink chain from
  // spinning forever.
  for (let depth = 0; depth < 12; depth++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return __dirname;
}

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
export declare function resolveProjectRoot(): string;

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveProjectRoot = resolveProjectRoot;
// SPDX-License-Identifier: MIT
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
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
function resolveProjectRoot() {
    let dir = __dirname;
    // Bounded walk: the root of a drive is at most a handful of levels
    // below any project, and the bound stops a broken symlink chain from
    // spinning forever.
    for (let depth = 0; depth < 12; depth++) {
        if (fs.existsSync(path.join(dir, "package.json")))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return __dirname;
}
//# sourceMappingURL=paths.js.map
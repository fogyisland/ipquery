"use strict";
// SPDX-License-Identifier: MIT
//
// Optional demo data loader.
//
// The demo rows (50 hand-picked addresses: Google DNS, Cloudflare, the
// RFC 1918 ranges, …) used to be inserted by migration 012, which meant
// every database carried them whether the operator wanted them or not.
// A production install that skipped seeding still answered /lookup for
// 8.8.8.8, which reads as "populated" when the table holds nothing but
// demo addresses.
//
// They are now opt-in. This module is the single place that loads them,
// so the CLI command and the setup wizard cannot drift apart.
//
// The rows live in a .sql file rather than being written out in code:
// they are data, they were reviewed as SQL, and keeping them as SQL
// means the byte-order fix (16-byte right-aligned IPv4) stays visible
// to whoever reads them next.
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
exports.DEMO_SOURCE = void 0;
exports.findDemoSeedFile = findDemoSeedFile;
exports.loadDemoSeed = loadDemoSeed;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/** The country_source value that marks every demo row. */
exports.DEMO_SOURCE = "seed";
/** Locates the demo-ranges.sql file.
 *
 *  In the compiled tree it sits next to the migrations under
 *  dist/storage/seed/. In a tsx/tsx-dev run it sits under
 *  src/storage/seed/. Both are resolved so the command works in
 *  development and from the release bundle without a build step in
 *  between.
 */
function findDemoSeedFile() {
    const candidates = [
        path.join(__dirname, "demo-ranges.sql"),
        path.join(__dirname, "..", "..", "src", "storage", "seed", "demo-ranges.sql"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}
/** Loads the demo rows into ip_ranges. Idempotent: the rows are inserted
 *  with INSERT IGNORE, backed by the uniq_seed UNIQUE index.
 *
 *  Does NOT run migrations — the caller decides when that happens. The
 *  setup wizard runs migrations before reaching the seed step, and the
 *  CLI command runs them itself; doing it here too would hide a
 *  migration failure behind a seed operation.
 */
async function loadDemoSeed(pool) {
    const seedFile = findDemoSeedFile();
    if (!seedFile) {
        throw new Error("demo-ranges.sql not found — the build did not copy the seed file " +
            "(run `npm run build`, or check dist/storage/seed/)");
    }
    const countDemoRows = async () => {
        const [rows] = await pool.query("SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = ?", [exports.DEMO_SOURCE]);
        return Number(rows[0]?.n ?? 0);
    };
    const before = await countDemoRows();
    await pool.query(fs.readFileSync(seedFile, "utf8"));
    const total = await countDemoRows();
    return { total, added: total - before };
}
//# sourceMappingURL=demoSeed.js.map
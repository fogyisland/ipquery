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
exports.getAppliedVersions = getAppliedVersions;
exports.runMigrations = runMigrations;
exports.migrationStatus = migrationStatus;
exports.listMigrationFiles = listMigrationFiles;
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;
async function getAppliedVersions(pool) {
    await pool.query(SCHEMA_MIGRATIONS_DDL);
    const [rows] = await pool.query("SELECT version FROM schema_migrations");
    return new Set(rows.map((r) => String(r.version)));
}
async function runMigrations(pool) {
    const migrationsDir = path.join(__dirname);
    const entries = await fs.readdir(migrationsDir);
    const files = entries.filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const applied = await getAppliedVersions(pool);
    const newlyApplied = [];
    const skipped = [];
    for (const file of files) {
        const version = file.slice(0, 3);
        if (applied.has(version)) {
            skipped.push(version);
            continue;
        }
        const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query(sql);
            await conn.query("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
            await conn.commit();
            newlyApplied.push(version);
        }
        catch (err) {
            await conn.rollback();
            throw new Error(`migration ${version} failed: ${err.message}`);
        }
        finally {
            conn.release();
        }
    }
    return { applied: newlyApplied, skipped };
}
async function migrationStatus(pool) {
    const migrationsDir = path.join(__dirname);
    const entries = await fs.readdir(migrationsDir);
    const files = entries.filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const allVersions = files.map((f) => f.slice(0, 3));
    const applied = await getAppliedVersions(pool);
    return {
        applied: allVersions.filter((v) => applied.has(v)),
        pending: allVersions.filter((v) => !applied.has(v)),
    };
}
async function listMigrationFiles() {
    const migrationsDir = path.join(__dirname);
    const entries = await fs.readdir(migrationsDir);
    return entries.filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
}
//# sourceMappingURL=runner.js.map
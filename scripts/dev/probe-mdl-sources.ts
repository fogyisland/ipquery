// SPDX-License-Identifier: MIT
//
// Probe: which row-count sources survive a metadata lock on `ip_ranges`?
//
// The console's `/admin/ranges` page counts the library on every render.
// When another session holds a write lock on the table, that count blocks
// until `lock_wait_timeout` and then throws — which is how the page turned
// into a 500. The question this probe answers is which sources are immune:
//
//   · the stored count   — a row in `settings`, a different table entirely
//   · the index estimate — `information_schema.tables`, which may or may not
//                          need the table's metadata lock
//   · a live COUNT(*)    — needs the table, so it blocks by construction
//
// It runs against a throwaway database: the live library must not be
// locked, not even for a second.
// The credentials come from .env via dotenv — never on the command line.
import * as dotenv from "dotenv";
import * as mysql from "mysql2/promise";

dotenv.config({ path: ".env" });

const SCRATCH_DB = "ipq_mdl_probe";

interface DbOptions {
  host: string;
  port: number;
  user: string;
  password: string;
}

function baseOptions(): DbOptions {
  return {
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
  };
}

async function main(): Promise<void> {
  const admin = await mysql.createConnection(baseOptions());
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await admin.query(`CREATE DATABASE \`${SCRATCH_DB}\``);
  await admin.end();

  const locker = await mysql.createConnection({ ...baseOptions(), database: SCRATCH_DB });
  await locker.query(
    `CREATE TABLE ip_ranges (
       id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
       range_size BIGINT UNSIGNED NULL
     ) ENGINE=InnoDB`,
  );
  // The stored count lives in its own table, the way the console's
  // `settings` table holds the live library's count. Reading it must not
  // care at all that `ip_ranges` is locked.
  await locker.query(
    `CREATE TABLE stored_counts (
       k VARCHAR(64) PRIMARY KEY,
       v VARCHAR(64) NOT NULL
     ) ENGINE=InnoDB`,
  );
  await locker.query("INSERT INTO stored_counts (k, v) VALUES ('ip_ranges_count', '8152112')");
  await locker.query("LOCK TABLES ip_ranges WRITE");

  const reader = await mysql.createConnection({ ...baseOptions(), database: SCRATCH_DB });
  await reader.query("SET SESSION lock_wait_timeout = 3");

  const probe = async (name: string, sql: string): Promise<void> => {
    const started = Date.now();
    try {
      const [rows] = await reader.query<mysql.RowDataPacket[]>(sql);
      console.log(`${name}: OK in ${Date.now() - started}ms -> ${JSON.stringify(rows[0])}`);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "?";
      console.log(`${name}: FAILED after ${Date.now() - started}ms -> ${code}: ${(err as Error).message}`);
    }
  };

  await probe(
    "stored count (a row in another table)",
    "SELECT v AS c FROM stored_counts WHERE k = 'ip_ranges_count'",
  );
  await probe(
    "index estimate (information_schema.tables)",
    `SELECT table_rows AS c FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'ip_ranges'`,
  );
  await probe("live COUNT(*)", "SELECT COUNT(*) AS c FROM ip_ranges");

  await locker.query("UNLOCK TABLES");
  await locker.end();
  await reader.end();

  const cleanup = await mysql.createConnection(baseOptions());
  await cleanup.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await cleanup.end();
}

void main().catch((err: unknown) => {
  console.error("probe failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

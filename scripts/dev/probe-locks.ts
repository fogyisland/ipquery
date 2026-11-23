// SPDX-License-Identifier: MIT
// Probe: is the rogue diagnostic thread still holding a lock on ip_ranges?
// The credentials come from .env via dotenv — never on the command line.
import * as dotenv from "dotenv";
import * as mysql from "mysql2/promise";

dotenv.config({ path: ".env" });

async function main(): Promise<void> {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
  });
  const [threads] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT id, time, state, LEFT(info, 200) AS info
       FROM information_schema.processlist
      WHERE command <> 'Sleep'
      ORDER BY time DESC`,
  );
  console.log("=== active threads ===");
  for (const t of threads) {
    console.log(`id=${t.id} time=${t.time}s state=${t.state}`);
    console.log(`  ${t.info ?? ""}`);
  }

  const [mdl] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT * FROM performance_schema.metadata_locks
      WHERE OBJECT_NAME = 'ip_ranges' AND LOCK_STATUS <> 'GRANTED'`,
  );
  console.log("=== pending metadata locks on ip_ranges ===");
  console.log(mdl.length === 0 ? "(none)" : JSON.stringify(mdl, null, 2));

  const [tbl] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT * FROM information_schema.innodb_trx WHERE trx_query IS NOT NULL AND trx_query <> ''`,
  );
  console.log("=== innodb transactions with a query ===");
  console.log(tbl.length === 0 ? "(none)" : JSON.stringify(tbl, null, 2));

  await conn.end();
}

void main().catch((err: unknown) => {
  console.error("probe failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

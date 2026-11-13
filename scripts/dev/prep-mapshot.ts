// scripts/dev/prep-mapshot.ts — create the throwaway database the map
// screenshot script renders against.
//
// Run: npx tsx scripts/dev/prep-mapshot.ts
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { markInitialized } from "../../src/storage/settings";

const DB_NAME = process.env.MAPSHOT_DB ?? "ipquery_mapshot";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  // CREATE ... IF NOT EXISTS rather than DROP + CREATE: this script only
  // prepares a scratch database for a screenshot, and it has no reason to
  // destroy anything that happens to be lying around.
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
  await root.end();
  const pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: DB_NAME,
    connectionLimit: 2,
    multipleStatements: true,
    timezone: "Z",
    dateStrings: false,
  });
  await runMigrations(pool);
  await markInitialized(pool);
  await pool.end();
  console.log(`prepared ${DB_NAME}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

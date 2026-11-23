// SPDX-License-Identifier: MIT
//
// Interrupt one MySQL statement by its thread id.
//
// ── Why this exists ─────────────────────────────────────────────────
//
// On 2026-11-23 the site stopped answering /dashboard while the
// homepage still answered in 10 ms. The cause was a metadata-lock
// queue on `ip_ranges`:
//
//   1. Thread 10583 held a SHARED metadata lock on `ip_ranges` while
//      running a hand-written diagnostic:
//
//        SELECT HEX(r.start_ip) hx, HEX(r.end_ip) hex2, r.country_code
//          FROM ip_ranges r
//         WHERE r.country_source IS NULL
//           AND NOT EXISTS (SELECT 1 FROM ip_ranges d
//                            WHERE d.country_source IS NOT NULL
//                              AND d.start_ip <= r.start_ip AND d.end_ip >= r.start_ip)
//
//      MySQL 5.7 does not turn that correlated subquery into a
//      semi-join, so the statement scans `ip_ranges` once per row.
//      With ~7.8M rows that is ~7.8M table scans — it ran for 42
//      hours without finishing.
//
//   2. The ETL's `RENAME TABLE` swap (thread 16917) then asked for an
//      EXCLUSIVE metadata lock. It went PENDING and became the head
//      of the queue.
//
//   3. A pending EXCLUSIVE request makes every LATER request wait, so
//      all 35 subsequent readers queued behind it. Every route that
//      touches `ip_ranges` hung; the homepage did not, because it
//      reads no IP table.
//
//   4. The two waited on each other. 16917 could not get the lock
//      while 10583 held it; 10583 was never going to finish on its
//      own. Neither could complete without the other being stopped.
//
// `KILL QUERY <id>` interrupts the running STATEMENT and leaves the
// connection open. It releases the statement's metadata lock, which
// lets the queue drain. `KILL <id>` (without QUERY) would also drop
// the session.
//
// ── Which thread to interrupt ───────────────────────────────────────
//
// The choice is the operator's, and it is not equivalent:
//
//   - The RENAME (the ETL's swap). Interrupting it abandons the swap.
//     The live `ip_ranges` keeps its current contents — 7.8M rows,
//     964 MB — and every reader unblocks at once. The ETL run behind
//     it has already been recorded as failed, so nothing was going to
//     publish that swap anyway. This is the safe choice.
//
//   - The diagnostic. Interrupting it lets the RENAME proceed, which
//     replaces `ip_ranges` with the staged `ip_ranges_new` (8.2M rows,
//     1.1 GB — newer monthly data). That may well be the data you
//     want, but the swap belongs to a run that has already been
//     recorded as failed, and nothing would verify the result.
//
// In short: interrupt the swap, not the diagnostic.
//
// ── Credentials ─────────────────────────────────────────────────────
//
// They come from .env via dotenv. The password is never placed on a
// command line and never written into this file.
import * as dotenv from "dotenv";
import * as mysql from "mysql2/promise";

dotenv.config({ path: ".env" });

async function main(): Promise<void> {
  const target = Number(process.argv[2] ?? 0);
  if (!Number.isFinite(target) || target <= 0) {
    console.error("usage: tsx scripts/dev/interrupt-statement.ts <threadId>");
    process.exitCode = 1;
    return;
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "ipquery",
  });

  // Show the statement before interrupting it, so the operator sees
  // what they are about to stop — and so the output records it.
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id, time, state, info FROM information_schema.processlist WHERE id = ?",
    [target],
  );
  const row = rows[0];
  if (!row) {
    console.error(`thread ${target} is not running — nothing to interrupt`);
    await conn.end();
    return;
  }
  console.log(`thread ${target} — state=${row.state} age=${row.time}s`);
  console.log(String(row.info ?? "").slice(0, 240).replace(/\s+/g, " "));

  try {
    await conn.query("KILL QUERY ?", [target]);
    console.log(`\ninterrupted thread ${target} (statement only; connection left open)`);
  } catch (err) {
    console.error(
      "interrupt failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
  }
  await conn.end();
}

void main();

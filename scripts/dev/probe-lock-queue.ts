// SPDX-License-Identifier: MIT
//
// Map the metadata-lock queue on ip_ranges.
//
// ── What this answers ──────────────────────────────────────────────
//
// "The site is slow" is not a diagnosis. This prints the queue:
//
//   - which threads are running, waiting, and for how long;
//   - which statement each one is running;
//   - how many readers are stuck behind a pending EXCLUSIVE request.
//
// It reads only information_schema.processlist and innodb_trx, neither
// of which needs a metadata lock on the tables they describe — so it
// answers even while the swap is stuck.
//
// ── The rule that makes a site hang ─────────────────────────────────
//
// A SHARED metadata lock does not block another SHARED one. A
// long-running SELECT on `ip_ranges` therefore does NOT, by itself,
// stop other readers.
//
// What stops them is a PENDING EXCLUSIVE request — the ETL's
// `RENAME TABLE` swap. Once one is pending, every LATER request
// queues behind it, so the queue grows on both tables the rename
// touches. That is the shape to look for here.
//
// ── Credentials ─────────────────────────────────────────────────────
//
// From .env via dotenv. The password is never placed on a command
// line and never written into this file.
import * as dotenv from "dotenv";
import * as mysql from "mysql2/promise";

dotenv.config({ path: ".env" });

async function main(): Promise<void> {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "ipquery",
  });

  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT id, time, state, command, LEFT(info, 160) AS q
       FROM information_schema.processlist
      WHERE command <> 'Sleep'
      ORDER BY time DESC`,
  );

  const oneLine = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

  const waiting = rows.filter((r) => /Waiting for table metadata lock/.test(String(r.state)));
  const running = rows.filter((r) => !waiting.includes(r));

  console.log(`=== ${running.length} running, ${waiting.length} waiting for a metadata lock ===`);
  console.log("");
  console.log("--- running (holding locks) ---");
  for (const r of running.slice(0, 10)) {
    console.log(`id=${r.id} age=${r.time}s ${r.state}`);
    console.log(`   ${oneLine(r.q).slice(0, 150)}`);
  }

  console.log("");
  console.log("--- waiting (queued behind the head of the queue) ---");
  for (const r of waiting.slice(0, 10)) {
    console.log(`id=${r.id} age=${r.time}s  ${oneLine(r.q).slice(0, 120)}`);
  }
  if (waiting.length > 10) console.log(`   … and ${waiting.length - 10} more`);

  // The head of the queue is the statement everyone is behind. It is
  // the one to interrupt.
  //
  // The rows arrive newest-first (ORDER BY time DESC) and the MySQL
  // metadata-lock queue is served in ARRIVAL order — so the head is
  // the OLDEST waiter, which is the FIRST entry in a newest-first
  // list. Picking the wrong end would point the operator at an
  // innocent thread that arrived ten minutes ago while the real
  // culprit stayed running.
  const head = waiting[0];
  if (head) {
    console.log("");
    console.log("--- the head of the queue (the one blocking everything) ---");
    console.log(`id=${head.id} age=${head.time}s  ${oneLine(head.q).slice(0, 160)}`);
    console.log(
      `interrupt it with: npx tsx scripts/dev/interrupt-statement.ts ${head.id}`,
    );
  } else {
    console.log("");
    console.log("--- nothing is waiting for a metadata lock ---");
  }

  console.log("");
  console.log("--- open transactions ---");
  const [trx] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT trx_mysql_thread_id AS thread, trx_state, trx_started,
            trx_operation_state, trx_tables_in_use, trx_rows_locked
       FROM information_schema.innodb_trx`,
  );
  if (trx.length === 0) console.log("(none)");
  else for (const t of trx) console.log(JSON.stringify(t));

  await conn.end();
}

void main().catch((err: unknown) => {
  console.error("probe failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

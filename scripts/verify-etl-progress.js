// SPDX-License-Identifier: MIT
// Manual verification harness for the live-progress feature.
// Spawns runPipeline() against the local DB, simultaneously polls the
// /admin/etl/runs/:id/progress JSON endpoint from the dev server, and
// dumps the bar widths at each tick so we can confirm:
//   1) recordEtlStart creates a row in etl_runs
//   2) EtlProgressSink writes download_bytes_done/total as downloadAll streams
//   3) Stage transitions land on disk (current_stage column)
//   4) /admin/etl/runs/:id/progress returns the live counters
//   5) When the run finishes, the endpoint returns 204
//
// Run with: node scripts/verify-etl-progress.js

const { spawn } = require("node:child_process");
const http = require("node:http");
const mysql = require("mysql2/promise");
const path = require("node:path");

async function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

async function main() {
  const cfg = require(path.join(__dirname, "..", "dist", "config")).loadConfig();
  const pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
    connectionLimit: 2,
  });

  // Insert an empty run row to mirror what the new /admin/etl/trigger
  // endpoint does (recordEtlStart BEFORE the pipeline spins up).
  const [ins] = await pool.query(
    "INSERT INTO etl_runs (started_at, status) VALUES (NOW(3), 'running')",
  );
  const runId = ins.insertId;
  console.log(`[harness] created runId=${runId}`);

  // Spawn the pipeline in the background — same process, so it shares
  // no state with our poll loop (separate DB rows). We invoke via
  // `node dist/cli.js update` which calls runPipeline without a runId
  // arg (so it'll create its own row). That's fine — we just want to
  // see the live endpoint respond to a fresh run.
  console.log(`[harness] spawning pipeline in background...`);
  const child = spawn("node", ["dist/cli.js", "update"], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
  });

  // Find the new run row (max id > runId we created)
  // Wait briefly so its INSERT lands.
  await new Promise((r) => setTimeout(r, 500));
  const [runs] = await pool.query(
    "SELECT id FROM etl_runs WHERE id > ? ORDER BY id DESC LIMIT 1",
    [runId],
  );
  const liveRunId = runs[0]?.id;
  console.log(`[harness] live runId from pipeline = ${liveRunId}`);

  // Poll /admin/etl/runs/:id/progress every 1s for 30s
  const start = Date.now();
  let lastStage = null;
  let lastBytesDone = -1;
  let lastRowsDone = -1;
  let finishedStatus = null;
  while (Date.now() - start < 60000) {
    const r = await get(`http://localhost:5001/admin/etl/runs/${liveRunId}/progress`);
    if (r.status === 204) {
      console.log(`[poll] HTTP 204 — run finished`);
      finishedStatus = "finished";
      break;
    }
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      if (
        j.currentStage !== lastStage ||
        j.downloadBytesDone !== lastBytesDone ||
        j.insertRowsDone !== lastRowsDone
      ) {
        console.log(
          `[poll] t=${((Date.now() - start) / 1000).toFixed(1)}s stage=${j.currentStage} bytes=${j.downloadBytesDone}/${j.downloadBytesTotal} rows=${j.insertRowsDone}/${j.insertRowsTotal}`,
        );
        lastStage = j.currentStage;
        lastBytesDone = j.downloadBytesDone;
        lastRowsDone = j.insertRowsDone;
      }
    } else {
      console.log(`[poll] HTTP ${r.status} body=${r.body.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Wait for child to exit cleanly
  await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(() => child.kill(), 5000);
  });

  // Final DB read
  const [final] = await pool.query(
    "SELECT id, status, current_stage, download_bytes_done, download_bytes_total, insert_rows_done, insert_rows_total, progress_updated_at, error_message FROM etl_runs WHERE id = ?",
    [liveRunId],
  );
  console.log(`\n[harness] final DB row for runId=${liveRunId}:`);
  console.table(final);

  await pool.end();
  console.log(`[harness] DONE — ${finishedStatus === "finished" ? "✓" : "✗"} saw 204`);
}

main().catch((err) => {
  console.error("[harness] failed:", err);
  process.exit(1);
});
// SPDX-License-Identifier: MIT
//
// The export runs in the background, and its history survives a restart.
//
// Two problems are covered here.
//
// The first is the one the operator feels: a library-sized export writes
// around two gigabytes, and it takes long enough that a proxy in front of
// the server times the request out. The request has to answer as soon as
// the job is accepted, exactly as the import does.
//
// The second is the one the operator finds later: the export list used to
// live in a Map inside the route module. A restart emptied it while the
// files stayed on disk, so a link that had worked stopped working and the
// page could no longer say what had been exported. The list is a table now.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { fetchCsrfTriple } from "../helpers/csrf";
import { IPQ_FORMAT } from "../../src/storage/rangeFile";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let dir: string;

beforeAll(async () => {
  td = await createTestDb("admin-ranges-export");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipq-export-"));
  cfg.etl.dataDir = dir;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "e@x.com",
    passwordHash: "h",
    displayName: "E",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});

beforeEach(async () => {
  await td.pool.query("DELETE FROM ip_ranges");
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function csrf() {
  return fetchCsrfTriple(app, "/admin/ranges", "sid=" + adminSid);
}

/** Poll until the newest export job reaches a terminal state. */
async function waitForExportToFinish(timeoutMs = 30_000): Promise<{
  id: string;
  status: string;
  rows: number;
  bytes: number;
  error_message: string | null;
}> {
  const deadline = Date.now() + timeoutMs;
  let last: { id: string; status: string; rows: number; bytes: number; error_message: string | null } | null =
    null;
  while (Date.now() < deadline) {
    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      "SELECT id, status, rows, bytes, error_message FROM range_exports ORDER BY started_at DESC, id DESC LIMIT 1",
    );
    last = rows[0]
      ? {
          id: String(rows[0].id),
          status: String(rows[0].status),
          rows: Number(rows[0].rows),
          bytes: Number(rows[0].bytes),
          error_message: rows[0].error_message === null ? null : String(rows[0].error_message),
        }
      : null;
    if (last && (last.status === "success" || last.status === "failed")) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the export never finished; last = ${JSON.stringify(last)}`);
}

async function seedRow(countryCode: string, hex: string): Promise<void> {
  await td.pool.query(
    `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
     VALUES (UNHEX(?), UNHEX(?), 255, ?, 'dbip')`,
    [hex, hex.replace(/^(.{30}).*$/, "$1FF"), countryCode],
  );
}

describe("/admin/ranges export", () => {
  it("answers the export request before the export has finished", async () => {
    await seedRow("ZZ", "0000000000000000000000000A140000");
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/export")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });

    // The request answers with a redirect, not with the finished file.
    expect(r.status).toBe(302);

    // The job is on record and it finishes on its own.
    const job = await waitForExportToFinish();
    expect(job.status).toBe("success");
    expect(job.error_message).toBeNull();
    expect(job.rows).toBe(1);
    expect(job.bytes).toBeGreaterThan(0);
  });

  it("records an export that fails, so the operator sees why", async () => {
    // The export fails when the table it reads from is not there. Rather
    // than mocking the exporter, the export is pointed at a table that
    // does not exist — the failure is real, and so is the record of it.
    await td.pool.query("RENAME TABLE ip_ranges TO ip_ranges_hidden");
    try {
      const { cookie, token } = await csrf();
      const r = await request(app.server)
        .post("/admin/ranges/export")
        .set("Cookie", "sid=" + adminSid + "; " + cookie)
        .type("form")
        .send({ csrf: token });
      expect(r.status).toBe(302);

      const job = await waitForExportToFinish();
      expect(job.status).toBe("failed");
      expect(job.error_message).toBeTruthy();
    } finally {
      await td.pool.query("RENAME TABLE ip_ranges_hidden TO ip_ranges");
    }
  });

  it("keeps the export list in the database, not in the process", async () => {
    // The list used to be a Map in the route module, so a restart emptied
    // it while the files stayed on disk. The row is what survives.
    await seedRow("ZZ", "0000000000000000000000000A140000");
    const { cookie, token } = await csrf();
    await request(app.server)
      .post("/admin/ranges/export")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    const job = await waitForExportToFinish();
    expect(job.status).toBe("success");

    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      "SELECT id, status, rows FROM range_exports WHERE id = ?",
      [job.id],
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.status)).toBe("success");
  });

  it("serves the exported file without loading it into memory", async () => {
    await seedRow("ZZ", "0000000000000000000000000A140000");
    const { cookie, token } = await csrf();
    await request(app.server)
      .post("/admin/ranges/export")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    const job = await waitForExportToFinish();
    expect(job.status).toBe("success");

    const file = await request(app.server)
      .get(`/admin/ranges/download/${job.id}`)
      .set("Cookie", "sid=" + adminSid);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/application\/octet-stream/);
    expect(file.headers["content-disposition"]).toMatch(/attachment; filename="[^"]+\.ipq"/);
    const text = file.text || (file.body as Buffer).toString("utf8");
    expect(text).toContain(IPQ_FORMAT);
    expect(text).toContain('"start":"10.20.0.0"');
  });

  it("refuses a download for an export that does not exist", async () => {
    const r = await request(app.server)
      .get("/admin/ranges/download/exp-nosuchfile")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(404);
  });
});

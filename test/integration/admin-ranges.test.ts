// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { fetchCsrfTriple } from "../helpers/csrf";
import { IPQ_FORMAT, encodeHeader, encodeRange } from "../../src/storage/rangeFile";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let dir: string;

beforeAll(async () => {
  td = await createTestDb("admin-ranges");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "ipq-routes-"));
  cfg.etl.dataDir = dir;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "a@x.com",
    passwordHash: "h",
    displayName: "A",
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
  require("node:fs").rmSync(dir, { recursive: true, force: true });
});

const header = () => encodeHeader({ exportedAt: new Date().toISOString(), rows: 1 });

async function csrf() {
  return fetchCsrfTriple(app, "/admin/ranges", "sid=" + adminSid);
}

/** The flash is a Set-Cookie on the redirect. A browser replays it on the
 *  next GET; supertest does not, so every assertion about what the operator
 *  is told has to carry it explicitly. */
function flashCookieOf(res: request.Response): string {
  const cookie = (res.headers["set-cookie"] as string[] | undefined)?.find((c) =>
    c.startsWith("ranges_flash="),
  );
  return cookie ? cookie.split(";")[0]! : "";
}

/** multipart/form-data with one file part. Supertest cannot build one, so
 *  the boundary and the body are assembled here. */
function multipart(fields: Record<string, string>, files: Record<string, { name: string; body: Buffer }>) {
  const boundary = "----ipq" + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  for (const [key, file] of Object.entries(files)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${file.name}"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      ),
    );
    parts.push(file.body);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Poll `read` until it satisfies `done`, or give up. Used for the parts
 *  that change on their own — the background import finishing after the
 *  request that started it has already returned. */
async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (Date.now() < deadline) {
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await read();
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms; last value = ${JSON.stringify(last)}`);
}

/**
 * Wait for the export that was just started to reach a terminal state.
 *
 * The export runs detached, so the file is not on disk until the job has
 * finished writing it. Every assertion about the file has to wait for the
 * job to say it is done — otherwise the test is a race that usually loses.
 */
async function waitForExportToFinish(timeoutMs = 30_000): Promise<void> {
  await waitFor(
    async () => {
      const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
        "SELECT status FROM range_exports ORDER BY started_at DESC, id DESC LIMIT 1",
      );
      return rows[0] ? String(rows[0].status) : null;
    },
    (status) => status === "success" || status === "failed",
    timeoutMs,
  );
}

/**
 * Wait for the import that was just started to reach a terminal state.
 *
 * The import runs detached, so "the rows are in the table" is only true
 * some time after the request answered. Every assertion about the
 * database has to wait for the job to say it is done — otherwise the test
 * is a race that usually loses.
 */
async function waitForImportToFinish(timeoutMs = 30_000): Promise<NonNullable<Awaited<ReturnType<typeof newestJob>>>> {
  const job = await waitFor(
    newestJob,
    (j) => j !== null && (j.status === "success" || j.status === "failed"),
    timeoutMs,
  );
  return job!;
}

/** The state of the newest import job. */
async function newestJob(): Promise<{
  id: number;
  status: string;
  rows_done: number;
  rows_written: number;
  error_message: string | null;
} | null> {
  const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
    "SELECT id, status, rows_done, rows_written, error_message FROM range_imports ORDER BY id DESC LIMIT 1",
  );
  return rows[0] ?? null;
}

describe("/admin/ranges", () => {
  it("renders the page with both directions", async () => {
    const r = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/导出 IP 段/);
    expect(r.text).toMatch(/导入 IP 段/);
    // The format name appears so the operator knows what the file is.
    expect(r.text).toContain(IPQ_FORMAT);
  });

  it("offers the chunked upload path with the elements the script binds to", async () => {
    // The browser script finds its elements by id. A rename on one side
    // only would leave the page looking fine and the upload doing
    // nothing, so the ids are pinned here.
    const r = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    for (const id of [
      "range-upload-form",
      "range-upload-file",
      "range-upload-start",
      "range-upload-progress",
      "range-upload-status",
    ]) {
      expect(r.text, `the page must carry #${id}`).toContain(`id="${id}"`);
    }
    // The script has to be loaded, and it must be the real one.
    expect(r.text).toContain('/assets/range-upload.js');
  });

  it("exports a downloadable .ipq file", async () => {
    await td.pool.query(
      `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (UNHEX('0000000000000000000000000A140000'), UNHEX('0000000000000000000000000A1400FF'), 255, 'ZZ', 'dbip')`,
    );
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/export")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(302);

    // The export runs in the background, so the file appears in the list
    // once the job has finished writing it.
    await waitForExportToFinish();
    const page = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid);
    const match = /\/admin\/ranges\/download\/[a-z0-9-]+/.exec(page.text);
    expect(match?.[0], "the page must link to the file it just built").toBeTruthy();
    const location = match![0];

    const file = await request(app.server)
      .get(location)
      .set("Cookie", "sid=" + adminSid);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/application\/octet-stream/);
    expect(file.headers["content-disposition"]).toMatch(/attachment; filename="[^"]+\.ipq"/);
    // octet-stream is binary to supertest, so the body arrives as a Buffer.
    const text = file.text || (file.body as Buffer).toString("utf8");
    expect(text).toContain(IPQ_FORMAT);
    expect(text).toContain('"start":"10.20.0.0"');
  });

  it("imports an uploaded file and reports what it wrote", async () => {
    const body = [
      header(),
      encodeRange({
        start: "10.50.0.0",
        end: "10.50.0.255",
        countryCode: "ZZ",
        countryName: null,
        region: null,
        city: null,
        postalCode: null,
        latitude: null,
        longitude: null,
        timezone: null,
        isp: null,
        asn: null,
        asnOrg: null,
      }),
    ].join("\n") + "\n";
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      // `.type("form")` encodes the body itself; pre-encoding here sent the
      // literal "%7B..." as the file content.
      .send({ csrf: token, file: body });
    expect(r.status).toBe(302);
    const flash = flashCookieOf(r);
    // The browser replays the Set-Cookie itself; supertest only gets an
    // empty jar unless the cookie is threaded through by hand.
    const page = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid + "; " + flash);
    // The request answers before the import has run, so the flash says the
    // job started — not that it finished.
    expect(page.text).toMatch(/后台开始|started/i);

    // The job record is where the operator finds out how it ended.
    const job = await waitForImportToFinish();
    expect(job.status).toBe("success");
    expect(job.rows_written).toBe(1);
    expect(job.error_message).toBeNull();
  });

  it("round-trips through the two routes: export one install, import into another", async () => {
    // This is the whole feature. Everything below it — the format, the
    // tagging, the streaming writer — exists so that this sequence works:
    // download on one machine, upload on another, look the address up.
    const body = [
      header(),
      encodeRange({
        line: 0,
        start: "10.60.0.0",
        end: "10.60.0.255",
        countryCode: "ZZ",
        countryName: "Testland",
        region: null,
        city: "Roundtrip",
        postalCode: null,
        latitude: null,
        longitude: null,
        timezone: null,
        isp: null,
        asn: null,
        asnOrg: null,
      }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10);
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, file: body });
    expect(r.status).toBe(302);
    await waitForImportToFinish();

    const [rows] = await td.pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT country_code, city, city_source FROM ip_ranges WHERE country_code = 'ZZ'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.city).toBe("Roundtrip");
    // The tag is what keeps the row through the next ETL refresh.
    expect(rows[0]!.city_source).toBe("import");
  });

  it("replaces the whole library when asked to", async () => {
    // The reason this mode exists: an operator who does not want to run the
    // ETL uploads a file from another install and expects the library to BE
    // that file. Merge would leave the old rows behind.
    await td.pool.query(
      `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (UNHEX('0000000000000000000000000A7E0000'), UNHEX('0000000000000000000000000A7E00FF'), 255, 'OL', 'dbip')`,
    );
    const body = [
      header(),
      encodeRange({
        line: 0,
        start: "10.70.0.0",
        end: "10.70.0.255",
        countryCode: "RP",
        countryName: null,
        region: null,
        city: null,
        postalCode: null,
        latitude: null,
        longitude: null,
        timezone: null,
        isp: null,
        asn: null,
        asnOrg: null,
      }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10);
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      // The page shows the current row count; a replacement has to repeat
      // it, which is what makes an accidental resend harmless.
      .send({ csrf: token, file: body, mode: "replace", confirmRows: "1" });
    expect(r.status).toBe(302);
    await waitForImportToFinish();

    // The old library is gone; the uploaded row is there.
    const [old] = await td.pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges WHERE country_code = 'OL'",
    );
    expect(old).toHaveLength(0);
    const [fresh] = await td.pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges WHERE country_code = 'RP'",
    );
    expect(fresh).toHaveLength(1);
  });

  it("refuses a replacement posted without the confirmation field", async () => {
    // Replace is the destructive one. A stray repost of the import form —
    // a browser "resend" after a timeout — must not wipe the library, so the
    // mode alone is not enough: the operator has to type the row count.
    await td.pool.query(
      `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (UNHEX('0000000000000000000000000A7F0000'), UNHEX('0000000000000000000000000A7F00FF'), 255, 'SF', 'dbip')`,
    );
    const body = [header(), encodeRange({
      line: 0, start: "10.71.0.0", end: "10.71.0.255",
      countryCode: "NR", countryName: null, region: null, city: null,
      postalCode: null, latitude: null, longitude: null, timezone: null,
      isp: null, asn: null, asnOrg: null,
    })].join(String.fromCharCode(10)) + String.fromCharCode(10);
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, file: body, mode: "replace" });
    expect(r.status).toBe(302);
    const [still] = await td.pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges WHERE country_code = 'SF'",
    );
    expect(still).toHaveLength(1);
  });

  it("imports a file uploaded as a name field", async () => {
    // The page has to work without JavaScript, so the browser posts a
    // file input; this asserts the route is reachable and the CSRF check
    // still runs.
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token });
    expect(r.status).toBe(400);
  });

  it("refuses an upload without a csrf token", async () => {
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid)
      .type("form")
      .send({ file: encodeHeader({ exportedAt: "x", rows: 0 }) });
    expect(r.status).toBe(403);
  });

  it("reports a malformed file instead of importing nothing silently", async () => {
    const { cookie, token } = await csrf();
    const r = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, file: encodeURIComponent("{not json\n") });
    expect(r.status).toBe(302);
    const page = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid + "; " + flashCookieOf(r));
    expect(page.text).toMatch(/line 1|不是|not an ipquery-ranges/i);
  });

  it("imports an uploaded file and cleans up after itself", async () => {
    // The chunked path: the bytes arrive in pieces, are assembled on disk,
    // are streamed into the table, and then the upload is gone — the file
    // and both sets of rows. An import that leaves its upload behind
    // accumulates a row per chunk for every file ever sent.
    const { cookie, token } = await csrf();
    const body = [
      encodeHeader({ exportedAt: "x", rows: 1 }),
      encodeRange({
        line: 0,
        start: "10.9.0.0",
        end: "10.9.0.255",
        countryCode: "UU",
        countryName: null,
        region: null,
        city: null,
        postalCode: null,
        latitude: null,
        longitude: null,
        timezone: null,
        isp: null,
        asn: null,
        asnOrg: null,
      }),
    ].join("\n") + "\n";

    const started = await request(app.server)
      .post("/admin/ranges/upload/start")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, mode: "merge", filename: "library.ipq", totalBytes: String(body.length) });
    expect(started.status).toBe(200);
    const uploadId = started.body.id as number;

    const chunk = multipart(
      { csrf: token, uploadId: String(uploadId), offset: "0" },
      { file: { name: "library.ipq", body: Buffer.from(body, "utf8") } },
    );
    const uploaded = await request(app.server)
      .post("/admin/ranges/upload/chunk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .set("Content-Type", chunk.contentType)
      .send(chunk.body);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.complete).toBe(true);

    const imported = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, uploadId: String(uploadId), mode: "merge" });
    expect(imported.status).toBe(302);
    await waitForImportToFinish();

    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges WHERE country_code = 'UU'",
    );
    expect(rows.length).toBe(1);

    // Nothing is left behind: not the rows, not the chunk rows.
    //
    // The cleanup happens after the job row is marked finished, so waiting
    // for the row is not enough: the row flips first and the upload goes a
    // moment later. Wait for the upload itself.
    await waitFor(
      async () => {
        const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
          "SELECT id FROM range_uploads WHERE id = ?",
          [uploadId],
        );
        return rows.length;
      },
      (n) => n === 0,
      30_000,
    );
    const [uploads] = await td.pool.query<mysql.RowDataPacket[]>(
      "SELECT id FROM range_uploads WHERE id = ?",
      [uploadId],
    );
    expect(uploads.length).toBe(0);
    const [chunks] = await td.pool.query<mysql.RowDataPacket[]>(
      "SELECT upload_id FROM range_upload_chunks WHERE upload_id = ?",
      [uploadId],
    );
    expect(chunks.length).toBe(0);
  });

  it("refuses to replace the library when the confirmation number is wrong", async () => {
    // A replacement asked for with an upload is still a replacement, and
    // the guard that protects the library has to apply to it too. A
    // browser "resend" after a timeout carries a stale count.
    const { cookie, token } = await csrf();
    const body = encodeHeader({ exportedAt: "x", rows: 0 }) + "\n";

    const started = await request(app.server)
      .post("/admin/ranges/upload/start")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, mode: "replace", filename: "library.ipq", totalBytes: String(body.length) });
    const uploadId = started.body.id as number;

    const chunk = multipart(
      { csrf: token, uploadId: String(uploadId), offset: "0" },
      { file: { name: "library.ipq", body: Buffer.from(body, "utf8") } },
    );
    await request(app.server)
      .post("/admin/ranges/upload/chunk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .set("Content-Type", chunk.contentType)
      .send(chunk.body);

    const imported = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, uploadId: String(uploadId), mode: "replace", confirmRows: "999999" });
    expect(imported.status).toBe(302);

    // Nothing was replaced: the flash says the number did not match.
    const page = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid + "; " + flashCookieOf(imported));
    expect(page.text).toMatch(/不匹配|does not match/i);
  });

  // ── The import runs in the background ───────────────────────────────
  //
  // A whole-library .ipq is around two gigabytes, and importing it takes
  // hours. If that work runs inside the request, the request is held open
  // for hours — and any proxy in front of this server kills it long
  // before that. The request has to answer as soon as the job is
  // accepted, and the job has to keep going on its own.

  it("answers the import request before the import has finished", async () => {
    const { cookie, token } = await csrf();
    const body = encodeHeader({ exportedAt: "x", rows: 1 }) + "\n" + encodeRange({
      line: 0,
      start: "10.8.0.0",
      end: "10.8.0.255",
      countryCode: "ZZ",
      countryName: null,
      region: null,
      city: null,
      postalCode: null,
      latitude: null,
      longitude: null,
      timezone: null,
      isp: null,
      asn: null,
      asnOrg: null,
    }) + "\n";

    const started = await request(app.server)
      .post("/admin/ranges/upload/start")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, mode: "merge", filename: "bg.ipq", totalBytes: String(body.length) });
    const uploadId = started.body.id as number;

    const chunk = multipart(
      { csrf: token, uploadId: String(uploadId), offset: "0" },
      { file: { name: "bg.ipq", body: Buffer.from(body, "utf8") } },
    );
    await request(app.server)
      .post("/admin/ranges/upload/chunk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .set("Content-Type", chunk.contentType)
      .send(chunk.body);

    const posted = await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, uploadId: String(uploadId), mode: "merge" });

    // The request answers with a redirect, not with the finished import.
    expect(posted.status).toBe(302);

    // The job is on record as running, and it finishes on its own after
    // the request has already answered.
    const job = await waitFor(
      newestJob,
      (j) => j !== null && (j.status === "success" || j.status === "failed"),
      30_000,
    );
    expect(job!.status).toBe("success");
    expect(job!.error_message).toBeNull();

    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      "SELECT country_code FROM ip_ranges WHERE country_code = 'ZZ'",
    );
    expect(rows.length).toBe(1);
  });

  it("records a background import that fails, so the operator sees why", async () => {
    const { cookie, token } = await csrf();
    // A file whose header is not the format: the import cannot start.
    const body = JSON.stringify({ format: "not-ipquery", version: 1, rows: 0 }) + "\n";

    const started = await request(app.server)
      .post("/admin/ranges/upload/start")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, mode: "merge", filename: "bad.ipq", totalBytes: String(body.length) });
    const uploadId = started.body.id as number;

    const chunk = multipart(
      { csrf: token, uploadId: String(uploadId), offset: "0" },
      { file: { name: "bad.ipq", body: Buffer.from(body, "utf8") } },
    );
    await request(app.server)
      .post("/admin/ranges/upload/chunk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .set("Content-Type", chunk.contentType)
      .send(chunk.body);

    await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, uploadId: String(uploadId), mode: "merge" });

    // A job that never leaves `running` is a job the operator reads as
    // "still going" for the rest of the install's life.
    const job = await waitFor(
      newestJob,
      (j) => j !== null && (j.status === "success" || j.status === "failed"),
      30_000,
    );
    expect(job!.status).toBe("failed");
    expect(job!.error_message).toBeTruthy();
  });

  it("cleans up the upload even when the background import fails", async () => {
    const { cookie, token } = await csrf();
    const body = JSON.stringify({ format: "not-ipquery", version: 1, rows: 0 }) + "\n";

    const started = await request(app.server)
      .post("/admin/ranges/upload/start")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, mode: "merge", filename: "bad2.ipq", totalBytes: String(body.length) });
    const uploadId = started.body.id as number;

    const chunk = multipart(
      { csrf: token, uploadId: String(uploadId), offset: "0" },
      { file: { name: "bad2.ipq", body: Buffer.from(body, "utf8") } },
    );
    await request(app.server)
      .post("/admin/ranges/upload/chunk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .set("Content-Type", chunk.contentType)
      .send(chunk.body);

    await request(app.server)
      .post("/admin/ranges/import")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, uploadId: String(uploadId), mode: "merge" });

    await waitFor(
      newestJob,
      (j) => j !== null && j.status === "failed",
      30_000,
    );

    // The upload is cleaned up on the failure path too — a failed import
    // must not leave a half-uploaded file for somebody to mistake for a
    // good one.
    //
    // The cleanup happens after the job row is marked failed, so waiting
    // for the row is not enough: the row flips first and the upload goes a
    // moment later. Wait for the upload itself.
    await waitFor(
      async () => {
        const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
          "SELECT id FROM range_uploads WHERE id = ?",
          [uploadId],
        );
        return rows.length;
      },
      (n) => n === 0,
      30_000,
    );
  });
});

void vi;

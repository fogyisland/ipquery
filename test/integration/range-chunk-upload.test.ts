// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { fetchCsrfTriple } from "../helpers/csrf";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;
let dataDir: string;

beforeAll(async () => {
  td = await createTestDb("chunked-upload");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipq-chunks-"));
  cfg.etl.dataDir = dataDir;
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

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

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

const fileBody = (rows: number) =>
  Buffer.from(
    [
      JSON.stringify({ format: "ipquery-ranges", version: 1, exportedAt: "x", rows }),
      ...Array.from({ length: rows }, (_, i) =>
        JSON.stringify({ start: `10.${20 + i}.0.0`, end: `10.${20 + i}.0.255`, country: "US" }),
      ),
    ].join("\n") + "\n",
    "utf8",
  );

async function csrf() {
  return fetchCsrfTriple(app, "/admin/ranges", "sid=" + adminSid);
}

/**
 * The CSRF token, threaded through the multipart body.
 *
 * The token is not just a value the server compares — it is signed against
 * the session cookie and the `csrf_issued` / `csrf_bind` pair. The binding
 * is what stops a token minted for one form being replayed against another,
 * so the pair this helper returns has to be sent with every request, and
 * the token sent inside the multipart body is the one the triple holds.
 */
function formFields(pair: { cookie: string; token: string }): Record<string, string> {
  return { csrf: pair.token };
}

describe("/admin/ranges/upload", () => {
  it("uploads a file in chunks and says where to continue", async () => {
    // The whole reason for the endpoint: a five-hundred-megabyte file
    // cannot be one POST, and one that drops must not cost the whole thing.
    const body = fileBody(3);
    const { cookie, token } = await csrf();

    const started = await request(app.server)
      .post("/admin/ranges/upload/start")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, mode: "replace", filename: "library.ipq", totalBytes: String(body.length) });
    expect(started.status).toBe(200);
    const uploadId = started.body.id as number;
    expect(uploadId).toBeGreaterThan(0);

    const chunk = multipart(
      { csrf: token, uploadId: String(uploadId), offset: "0" },
      { file: { name: "library.ipq", body: body.subarray(0, Math.floor(body.length / 2)) } },
    );
    const first = await request(app.server)
      .post("/admin/ranges/upload/chunk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .set("Content-Type", chunk.contentType)
      .send(chunk.body);
    expect(first.status).toBe(200);
    expect(first.body.complete).toBe(false);
    expect(first.body.receivedBytes).toBe(Math.floor(body.length / 2));

    // The second half, at the offset the server said to use.
    const rest = multipart(
      { csrf: token, uploadId: String(uploadId), offset: String(first.body.nextOffset) },
      {
        file: {
          name: "library.ipq",
          body: body.subarray(Math.floor(body.length / 2)),
        },
      },
    );
    const second = await request(app.server)
      .post("/admin/ranges/upload/chunk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .set("Content-Type", rest.contentType)
      .send(rest.body);
    expect(second.status).toBe(200);
    expect(second.body.complete).toBe(true);

    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT total_bytes, received_bytes, status FROM range_uploads WHERE id = ?`,
      [uploadId],
    );
    expect(Number(rows[0]!.total_bytes)).toBe(body.length);
    expect(Number(rows[0]!.received_bytes)).toBe(body.length);
    expect(rows[0]!.status).toBe("ready");
  });

  it("refuses a chunk for an upload that does not exist", async () => {
    const { cookie, token } = await csrf();
    const chunk = multipart(
      { csrf: token, uploadId: "424242", offset: "0" },
      { file: { name: "library.ipq", body: Buffer.from("x") } },
    );
    const res = await request(app.server)
      .post("/admin/ranges/upload/chunk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .set("Content-Type", chunk.contentType)
      .send(chunk.body);
    expect(res.status).toBe(404);
  });

  it("refuses a chunk larger than the file says it is", async () => {
    // A chunk that would run past the declared size is either a corrupted
    // retry or a different file under the same id. Accepting it silently
    // produces a file longer than its own header claims.
    const { cookie, token } = await csrf();
    const started = await request(app.server)
      .post("/admin/ranges/upload/start")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, mode: "merge", filename: "library.ipq", totalBytes: "8" });
    const chunk = multipart(
      { csrf: token, uploadId: String(started.body.id), offset: "4" },
      { file: { name: "library.ipq", body: Buffer.from("way too many bytes") } },
    );
    const res = await request(app.server)
      .post("/admin/ranges/upload/chunk")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .set("Content-Type", chunk.contentType)
      .send(chunk.body);
    expect(res.status).toBe(400);
  });

  it("refuses to start an upload with no size", async () => {
    const { cookie, token } = await csrf();
    const res = await request(app.server)
      .post("/admin/ranges/upload/start")
      .set("Cookie", "sid=" + adminSid + "; " + cookie)
      .type("form")
      .send({ csrf: token, mode: "replace", filename: "library.ipq", totalBytes: "0" });
    expect(res.status).toBe(400);
  });

  it("needs a csrf token to upload at all", async () => {
    const res = await request(app.server)
      .post("/admin/ranges/upload/start")
      .set("Cookie", "sid=" + adminSid)
      .type("form")
      .send({ mode: "replace", filename: "library.ipq", totalBytes: "10" });
    expect(res.status).toBe(403);
  });
});

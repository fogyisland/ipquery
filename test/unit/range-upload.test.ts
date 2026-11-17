// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { reserveUpload, storeChunk, openUpload, finishUpload, UploadError } from "../../src/storage/rangeUpload";

const TEST_DB = "ipquery_range_upload_test";
let pool: mysql.Pool;

beforeAll(async () => {
  const cfg = loadConfig();
  cfg.db.database = TEST_DB;
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.query(`CREATE DATABASE \`${TEST_DB}\``);
  await root.end();
  pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: TEST_DB,
    connectionLimit: 3,
    multipleStatements: true,
    timezone: "Z",
  });
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.end();
});

describe("the resumable upload", () => {
  it("assembles a file from chunks sent out of order", async () => {
    // The reason the upload is chunked at all: a five-hundred-megabyte file
    // cannot survive one POST on a connection that can drop at any point.
    // Each chunk is small and independently retryable, and the order they
    // arrive in is not the order they belong in.
    const upload = await reserveUpload(pool, { mode: "replace", filename: "library.ipq", totalBytes: 13 });

    await storeChunk(pool, upload.id, 7, "world!");
    await storeChunk(pool, upload.id, 0, "Hello, ");

    const stream = await openUpload(pool, upload.id);
    const parts: Buffer[] = [];
    for await (const chunk of stream) parts.push(chunk as Buffer);
    expect(Buffer.concat(parts).toString("utf8")).toBe("Hello, world!");
  });

  it("tells the caller where to continue after a partial upload", async () => {
    // This is the answer to "my connection died halfway": the browser asks
    // what is already on the server and sends only what is missing.
    const upload = await reserveUpload(pool, { mode: "merge", filename: "library.ipq", totalBytes: 30 });
    await storeChunk(pool, upload.id, 0, "0123456789");

    const state = await openUpload(pool, upload.id);
    expect(state.receivedBytes).toBe(10);
    expect(state.nextOffset).toBe(10);
    expect(state.complete).toBe(false);
  });

  it("marks an upload complete only once every byte has landed", async () => {
    const upload = await reserveUpload(pool, { mode: "replace", filename: "library.ipq", totalBytes: 20 });
    await storeChunk(pool, upload.id, 0, "0123456789");
    expect((await openUpload(pool, upload.id)).complete).toBe(false);

    await storeChunk(pool, upload.id, 10, "0123456789");
    const done = await openUpload(pool, upload.id);
    expect(done.complete).toBe(true);
    expect(done.receivedBytes).toBe(20);
  });

  it("refuses a chunk past the end of the file", async () => {
    // A chunk that would extend past the declared size is either a
    // corrupted retry or a different file under the same id. Accepting it
    // silently would produce a file that is longer than its own header says.
    const upload = await reserveUpload(pool, { mode: "replace", filename: "library.ipq", totalBytes: 8 });
    await expect(storeChunk(pool, upload.id, 4, "far too long")).rejects.toThrow(UploadError);
  });

  it("refuses an id that does not exist", async () => {
    await expect(storeChunk(pool, 999999, 0, "x")).rejects.toThrow(UploadError);
  });

  it("reads back the file once it is complete", async () => {
    const upload = await reserveUpload(pool, { mode: "replace", filename: "library.ipq", totalBytes: 13 });
    await storeChunk(pool, upload.id, 0, "one\ntwo\n");
    await storeChunk(pool, upload.id, 8, "three");
    await finishUpload(pool, upload.id);

    const stream = await openUpload(pool, upload.id);
    let text = "";
    for await (const chunk of stream) text += String(chunk);
    expect(text).toBe("one\ntwo\nthree");
    expect((await openUpload(pool, upload.id)).complete).toBe(true);
  });

  it("treats a repeat of the same chunk as harmless", async () => {
    // A retry after a lost acknowledgement is the normal case for a
    // connection that can drop. The second write must not corrupt the file
    // and must not be refused.
    const upload = await reserveUpload(pool, { mode: "replace", filename: "library.ipq", totalBytes: 6 });
    await storeChunk(pool, upload.id, 0, "abc");
    await storeChunk(pool, upload.id, 0, "abc");
    await storeChunk(pool, upload.id, 3, "def");
    const stream = await openUpload(pool, upload.id);
    const parts: Buffer[] = [];
    for await (const chunk of stream) parts.push(chunk as Buffer);
    expect(Buffer.concat(parts).toString("utf8")).toBe("abcdef");
  });
});

// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { purgeAbandonedUploads, UPLOAD_ABANDONED_AFTER_HOURS } from "../../src/storage/rangeUpload";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("admin-ranges-sweep");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "s@x.com",
    passwordHash: "h",
    displayName: "S",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});

beforeEach(async () => {
  await td.pool.query("DELETE FROM range_upload_chunks");
  await td.pool.query("DELETE FROM range_uploads");
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("the abandoned-upload sweep", () => {
  it("removes an upload nobody came back for", async () => {
    // An upload that was started and never finished — the browser tab
    // closed, the laptop slept, the operator went for lunch. Its rows and
    // its file are dead weight: a two-gigabyte file on disk that nobody
    // will ever import.
    await td.pool.query(
      `INSERT INTO range_uploads (mode, filename, total_bytes, received_bytes, filepath, status, started_at)
       VALUES ('merge', 'old.ipq', 100, 100, 'upload-old.ipq', 'uploading',
               NOW(3) - INTERVAL ? HOUR)`,
      [UPLOAD_ABANDONED_AFTER_HOURS + 1],
    );
    await td.pool.query(`INSERT INTO range_upload_chunks (upload_id, \`offset\`, length) VALUES (1, 0, 100)`);

    const removed = await purgeAbandonedUploads(app.pool);

    expect(removed).toBeGreaterThanOrEqual(1);
    const [uploads] = await td.pool.query<mysql.RowDataPacket[]>("SELECT id FROM range_uploads");
    expect(uploads).toHaveLength(0);
    const [chunks] = await td.pool.query<mysql.RowDataPacket[]>("SELECT upload_id FROM range_upload_chunks");
    expect(chunks).toHaveLength(0);
  });

  it("leaves an upload that is still young alone", async () => {
    // A slow upload is not an abandoned one. The operator is on the other
    // end of a slow connection with a two-gigabyte file; sweeping their
    // upload out from under them would be a bug, not a cleanup.
    await td.pool.query(
      `INSERT INTO range_uploads (mode, filename, total_bytes, received_bytes, filepath, status, started_at)
       VALUES ('merge', 'fresh.ipq', 100, 10, 'upload-fresh.ipq', 'uploading', NOW(3))`,
    );

    await purgeAbandonedUploads(app.pool);

    const [uploads] = await td.pool.query<mysql.RowDataPacket[]>("SELECT id FROM range_uploads");
    expect(uploads).toHaveLength(1);
  });

  it("leaves an upload that is ready for import alone", async () => {
    // A finished upload is waiting to be imported. It is not abandoned —
    // it is ready, and the operator may still be about to press the
    // button.
    await td.pool.query(
      `INSERT INTO range_uploads (mode, filename, total_bytes, received_bytes, filepath, status, started_at, finished_at)
       VALUES ('merge', 'ready.ipq', 100, 100, 'upload-ready.ipq', 'ready',
               NOW(3) - INTERVAL ? HOUR, NOW(3) - INTERVAL ? HOUR)`,
      [UPLOAD_ABANDONED_AFTER_HOURS + 1, UPLOAD_ABANDONED_AFTER_HOURS + 1],
    );

    await purgeAbandonedUploads(app.pool);

    const [uploads] = await td.pool.query<mysql.RowDataPacket[]>("SELECT id FROM range_uploads");
    expect(uploads).toHaveLength(1);
  });
});

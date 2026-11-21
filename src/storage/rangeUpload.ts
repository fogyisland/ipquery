// SPDX-License-Identifier: MIT
//
// Resumable storage for a .ipq upload.
//
// A whole-library file is around two gigabytes. A single POST has to hold
// it all in memory before anything can be parsed, and one connection that
// drops part-way costs the whole thing. So the upload arrives as chunks,
// each one small enough to retry on its own, and they are assembled on
// disk.
//
// The assembly is a sparse file plus a set of received ranges: a chunk is
// written at its own offset, so the order it arrives in does not matter
// and a repeated chunk is a no-op rather than corruption. That is what
// makes an interrupted upload resumable — the browser asks what has landed
// and sends only what is missing.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Pool } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { runMigrations } from "./migrations/runner";

/** An upload that cannot continue. The message says which part is wrong:
 *  an offset past the end and a missing upload are different problems to
 *  the person looking at the browser console. */
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export interface ReservedUpload {
  readonly id: number;
  readonly mode: "merge" | "replace";
  readonly filename: string;
  readonly totalBytes: number;
  /** Where the assembled bytes live. The name is generated, never supplied
   *  by the caller — an upload id is not a path. */
  readonly filepath: string;
}

export interface UploadState extends ReservedUpload {
  readonly receivedBytes: number;
  /** Where the next missing byte is. The browser sends from here. */
  readonly nextOffset: number;
  readonly complete: boolean;
}

/** Chunk size the browser sends. Small enough to retry cheaply, large
 *  enough that a two-gigabyte file is not a hundred thousand requests. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Nothing may be uploaded larger than this. Two gigabytes covers a
 *  whole-library .ipq with room for the fields that make it readable. */
export const UPLOAD_MAX_BYTES = 3 * 1024 * 1024 * 1024;

function uploadDir(): string {
  return path.join(process.cwd(), "data", "uploads");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** A generated name. Only ever [a-z0-9-], so it can never escape the
 *  upload directory when joined back together. */
function safeName(id: number): string {
  return `upload-${id}.ipq`;
}

export async function reserveUpload(
  pool: Pool,
  fields: { mode: "merge" | "replace"; filename: string; totalBytes: number },
): Promise<ReservedUpload> {
  await runMigrations(pool);
  if (!Number.isFinite(fields.totalBytes) || fields.totalBytes <= 0) {
    throw new UploadError("the file size must be a positive number of bytes");
  }
  if (fields.totalBytes > UPLOAD_MAX_BYTES) {
    throw new UploadError(`the file is larger than the ${UPLOAD_MAX_BYTES} byte ceiling`);
  }
  await pool.query(
    `INSERT INTO range_uploads (mode, filename, total_bytes, received_bytes)
     VALUES (?, ?, ?, 0)`,
    [fields.mode, fields.filename.slice(0, 255), fields.totalBytes],
  );
  const [rows] = await pool.query<RowDataPacket[]>("SELECT LAST_INSERT_ID() AS id");
  const id = Number(rows[0]?.id ?? 0);
  ensureDir(uploadDir());
  const filepath = path.join(uploadDir(), safeName(id));
  // Pre-size the file so a chunk written at a high offset does not need to
  // extend it. Nothing reads it before the upload is complete.
  const handle = await fs.promises.open(filepath, "w");
  await handle.truncate(fields.totalBytes);
  await handle.close();
  await pool.query(`UPDATE range_uploads SET filepath = ? WHERE id = ?`, [safeName(id), id]);
  return { id, mode: fields.mode, filename: fields.filename, totalBytes: fields.totalBytes, filepath };
}

/**
 * Write one chunk at `offset`.
 *
 * Repeating a chunk is harmless: the bytes are written to the same place
 * and the received ranges are recomputed from what is on record, so a retry
 * after a lost acknowledgement does not corrupt the file.
 */
export async function storeChunk(
  pool: Pool,
  id: number,
  offset: number,
  data: Buffer | string,
): Promise<void> {
  await runMigrations(pool);
  const upload = await readUploadRow(pool, id);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  if (!Number.isInteger(offset) || offset < 0) {
    throw new UploadError(`the offset must be a whole number of bytes, got ${String(offset)}`);
  }
  if (offset + bytes.length > upload.totalBytes) {
    throw new UploadError(
      `a chunk at ${offset} would run past the end of the file (${upload.totalBytes} bytes)`,
    );
  }
  if (bytes.length === 0) return;

  const handle = await fs.promises.open(path.join(uploadDir(), safeName(id)), "r+");
  try {
    await handle.write(bytes, 0, bytes.length, offset);
  } finally {
    await handle.close();
  }
  await pool.query(
    `INSERT INTO range_upload_chunks (upload_id, offset, length) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE length = VALUES(length)`,
    [id, offset, bytes.length],
  );
  await recalculateReceived(pool, id);
}

/** Mark an upload as finished. Called when the browser says it has sent
 *  every byte, so a later reader does not have to decide for itself
 *  whether a short file is a partial upload or a complete one. */
export async function finishUpload(pool: Pool, id: number): Promise<void> {
  await runMigrations(pool);
  await pool.query(
    `UPDATE range_uploads SET status = 'ready', finished_at = NOW(3)
      WHERE id = ? AND received_bytes >= total_bytes`,
    [id],
  );
}

export interface OpenUpload extends UploadState {
  /** The assembled file, read as a stream. Only complete uploads have one
   *  worth reading. */
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
}

/**
 * The upload's state, and — when it is complete — a stream of its bytes.
 *
 * Read from disk rather than held: a two-gigabyte file is not something to
 * have as a string, and the importer wants it a line at a time anyway.
 */
export async function openUpload(pool: Pool, id: number): Promise<OpenUpload> {
  await runMigrations(pool);
  const upload = await readUploadRow(pool, id);
  const filepath = path.join(uploadDir(), safeName(id));
  const state: OpenUpload = {
    ...upload,
    [Symbol.asyncIterator]: () =>
      (async function* () {
        const handle = await fs.promises.open(filepath, "r");
        try {
          for await (const chunk of handle.createReadStream()) yield chunk as Buffer;
        } finally {
          await handle.close();
        }
      })(),
  };
  return state;
}

/**
 * Throw an upload away: the file on disk, the row that described it, and
 * the row for every chunk that was sent.
 *
 * The import is the inverse of the export, and nothing about an uploaded
 * file needs to outlive it. The chunk rows matter as much as the file: one
 * per chunk means a two-gigabyte upload leaves a hundred and twenty-eight
 * of them, and a year of imports is a table nobody reads and nobody dares
 * delete.
 *
 * Doing this twice is not an error — the import path discards the upload
 * and so does the sweep that clears abandoned ones.
 */
export async function discardUpload(pool: Pool, id: number): Promise<void> {
  await runMigrations(pool);
  await pool.query("DELETE FROM range_upload_chunks WHERE upload_id = ?", [id]);
  await pool.query("DELETE FROM range_uploads WHERE id = ?", [id]);
  // The file is removed last: if the rows are gone the upload is already
  // unusable, and a file left on disk is a file somebody has to sweep.
  await fs.promises.rm(path.join(uploadDir(), safeName(id)), { force: true }).catch(() => undefined);
}

async function readUploadRow(pool: Pool, id: number): Promise<UploadState> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, mode, filename, total_bytes, received_bytes, filepath
       FROM range_uploads WHERE id = ?`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new UploadError(`upload ${id} does not exist`);
  const totalBytes = Number(r.total_bytes);
  const receivedBytes = Number(r.received_bytes);
  // The column holds the file's name, not its path: the install's data
  // directory can move between runs, and a path stored in the database
  // would then point nowhere. The path is rebuilt here, which is also
  // what `reserveUpload` hands back — the two must agree, or the importer
  // opens a file that is not there.
  const name = path.basename(String(r.filepath ?? safeName(Number(r.id))));
  return {
    id: Number(r.id),
    mode: r.mode === "merge" ? "merge" : "replace",
    filename: String(r.filename ?? ""),
    totalBytes,
    filepath: path.join(uploadDir(), name),
    receivedBytes,
    nextOffset: Math.min(receivedBytes, totalBytes),
    complete: receivedBytes >= totalBytes,
  };
}

/**
 * Recompute how many bytes have landed.
 *
 * The chunks are recorded as ranges rather than as a running total so a
 * repeat does not double-count: summing the ranges is the only way to say
 * "20 bytes are here" when 10 of them arrived twice.
 */
async function recalculateReceived(pool: Pool, id: number): Promise<void> {
  // Summing the recorded chunks is wrong when one arrives twice: a retry
  // would double-count and the resume logic would report a file larger than
  // it is. The total is therefore the coverage of the byte range, which is
  // what the next offset is read from anyway.
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT offset, length FROM range_upload_chunks WHERE upload_id = ? ORDER BY offset ASC`,
    [id],
  );
  let covered = 0;
  let cursor = 0;
  for (const row of rows as unknown as { offset: number; length: number }[]) {
    const offset = Number(row.offset);
    const length = Number(row.length);
    if (offset > cursor) {
      cursor = offset;
    }
    if (offset + length > cursor) {
      covered += offset + length - cursor;
      cursor = offset + length;
    }
  }
  await pool.query(`UPDATE range_uploads SET received_bytes = ? WHERE id = ?`, [covered, id]);
}

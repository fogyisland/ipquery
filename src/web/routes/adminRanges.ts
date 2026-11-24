// SPDX-License-Identifier: MIT
//
// /admin/ranges — moving IP ranges in and out of this install.
//
// Export writes a file to DATA_DIR/exports and hands back a link, rather
// than piping the rows into the response: a nine-million-row library is
// around two gigabytes, and a download that a proxy or a flaky connection
// can cut off is a download that fails after ten minutes with no way to
// tell a truncated file from a whole one. The written file is also the one
// the operator can hand to another install, which is the point of the
// format.
//
// Import takes the file as a paste or a plain-text upload. The test-only
// concern is the paste: it is what the page offers when the file is small,
// and it is the path with no parser between the browser and this code.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as fs from "node:fs";
import { Readable } from "node:stream";
import multipart from "@fastify/multipart";
import * as path from "node:path";
import { verifyCsrfRequest } from "../plugins/csrf";
import { sendCsrfPage } from "../errors/render";
import { listRangeExports, readRangeExport, startRangeExport } from "../../storage/rangeExportJob";
import { formatDbTimestamp } from "../../storage/dbTimestamp";
import { listRangeImports, readRangeImportState } from "../../storage/rangeImport";
import { isRangeImportRunning, startRangeImport } from "../../storage/rangeImportJob";
import {
  discardUpload,
  finishUpload,
  openUpload,
  reserveUpload,
  stageImportFile,
  storeChunk,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_MAX_BYTES,
  UploadError,
} from "../../storage/rangeUpload";
import { decodeFile, RangeFileError, IPQ_DEFAULT_MAX_ROWS } from "../../storage/rangeFile";

const FLASH_COOKIE = "ranges_flash";

/**
 * The largest body these routes will parse.
 *
 * Fastify's default is 1 MB and `@fastify/formbody` inherits it. A .ipq
 * export of a few thousand ranges is already several megabytes, so the
 * default rejected the file the page itself produces — and it rejected it
 * from inside a pre-parsing hook, which resets the socket instead of
 * answering 413. The operator saw "connection reset" with no explanation.
 *
 * 512 MB is the ceiling for a whole-library file. It is a limit on the
 * request body, not on the import: `importRanges` and the streaming reader
 * keep their own bounds.
 */
export const RANGE_BODY_LIMIT = 512 * 1024 * 1024;

/** Where the export files live. The data directory moves between installs,
 *  so it is resolved at the moment the file is written or read rather than
 *  stored anywhere. */
function exportTargetDir(app: FastifyInstance): string {
  const targets = [app.cfg.etl.dataDir, path.join(process.cwd(), "data")];
  return targets[0] ?? process.cwd();
}

function exportDir(dataDir: string): string {
  return path.join(dataDir, "exports");
}

/** Generated names only — a caller never supplies the path that is opened. */
const EXPORT_ID = /^[a-z0-9-]{8,64}$/;

/**
 * How often the page may poll a running import's progress.
 *
 * The page polls every two seconds while a job is running, so 120 a
 * minute covers one open tab with plenty of room and bounds what a
 * hijacked admin session can spend.
 */
const RANGE_POLL_RATE_LIMIT = {
  max: 120,
  timeWindow: "1 minute",
} as const;

function setFlash(reply: FastifyReply, kind: "success" | "error", message: string): void {
  reply.setCookie(FLASH_COOKIE, JSON.stringify({ kind, message }), {
    path: "/admin/ranges",
    httpOnly: true,
    sameSite: "lax",
  });
}

function consumeFlash(
  req: FastifyRequest,
  reply: FastifyReply,
): { kind: "success" | "error"; message: string } | undefined {
  const raw = req.cookies[FLASH_COOKIE];
  if (!raw) return undefined;
  reply.clearCookie(FLASH_COOKIE, { path: "/admin/ranges" });
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; message?: unknown };
    if (typeof parsed.message !== "string") return undefined;
    return {
      kind: parsed.kind === "error" ? "error" : "success",
      message: parsed.message,
    };
  } catch {
    // A malformed flash cookie is not worth an error page — drop it.
    return undefined;
  }
}

/** Async because Fastify treats a plugin that returns nothing as
 *  "forgot to call done" — `register` needs a promise to await. */
export async function registerRangeRoutes(app: FastifyInstance): Promise<void> {
  // A whole-library .ipq is around two gigabytes. It cannot arrive as one
  // POST — the body is held in memory before a line is parsed — so the
  // upload is chunked and assembled on disk. `multipart` is what parses
  // those posts; the old plain-form path is kept for files small enough to
  // fit in a form, which is what the merge box takes.
  await app.register(multipart, {
    limits: {
      fileSize: UPLOAD_CHUNK_BYTES,
      files: 1,
      fields: 8,
    },
    // The chunked endpoints answer 400/404 in the body, not by resetting
    // the socket, so the browser gets a reason.
    throwFileSizeLimit: true,
  });

  app.post("/admin/ranges/upload/start", async (req, reply) => {
    if (!verifyCsrfRequest(req)) return sendCsrfPage(reply, 403);
    const body = req.body as Record<string, unknown> | undefined;
    const totalBytes = Number(body?.totalBytes ?? NaN);
    const mode = String(body?.mode ?? "replace") === "merge" ? "merge" : "replace";
    const filename = typeof body?.filename === "string" ? body.filename : "library.ipq";
    try {
      const upload = await reserveUpload(app.pool, { mode, filename, totalBytes });
      return reply.send({ id: upload.id, chunkBytes: UPLOAD_CHUNK_BYTES });
    } catch (err) {
      app.log.warn({ err }, "could not reserve an upload");
      return reply
        .code(400)
        .send({ error: err instanceof UploadError ? err.message : "cannot start an upload" });
    }
  });

  app.post("/admin/ranges/upload/chunk", async (req, reply) => {
    // The token arrives inside the multipart body, so the CSRF check has
    // to run AFTER the parts are read: `req.body` is not populated for a
    // multipart request. Nothing is written until that check passes.
    const parts = req.parts();
    let uploadId = 0;
    let offset = 0;
    let data: Buffer | null = null;
    const fields: Record<string, string> = {};
    for await (const part of parts) {
      if (part.type === "file") {
        // The whole chunk is read into memory. UPLOAD_CHUNK_BYTES is the
        // ceiling that makes that safe: one buffer of a few megabytes, not
        // one of the whole file.
        data = await part.toBuffer();
      } else if (part.fieldname === "uploadId") {
        uploadId = Number(part.value);
      } else if (part.fieldname === "offset") {
        offset = Number(part.value);
      } else if (part.fieldname === "csrf") {
        fields.csrf = String(part.value ?? "");
      }
    }
    if (!verifyCsrfRequest(req, fields)) {
      return sendCsrfPage(reply, 403);
    }
    if (!Number.isFinite(uploadId) || uploadId <= 0) {
      return reply.code(400).send({ error: "the upload id is missing" });
    }
    if (!data) {
      return reply.code(400).send({ error: "no file part in the request" });
    }
    try {
      await storeChunk(app.pool, uploadId, offset, data);
    } catch (err) {
      app.log.warn({ err }, "could not store an upload chunk");
      const missing = err instanceof UploadError && /does not exist/.test(err.message);
      return reply
        .code(missing ? 404 : 400)
        .send({ error: err instanceof UploadError ? err.message : "the chunk could not be stored" });
    }
    const state = await openUpload(app.pool, uploadId);
    if (state.complete) await finishUpload(app.pool, uploadId);
    return reply.send({
      complete: state.complete,
      receivedBytes: state.receivedBytes,
      nextOffset: state.nextOffset,
    });
  });

  /** Serve an assembled upload to the importer. Kept separate from the
   *  download route so a download link never reads a half-uploaded file. */
  app.get("/admin/ranges/upload/:id/stream", async (req, reply) => {
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send();
    const state = await openUpload(app.pool, id).catch(() => null);
    if (!state) return reply.code(404).send();
    if (!state.complete) return reply.code(409).send({ error: "the upload is not complete" });
    reply
      .header("Content-Type", "application/x-ndjson; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${state.filename}"`);
    return reply.send(Readable.from(state));
  });

  /**
   * Where a running import has got to.
   *
   * The page shows the progress, but only when it is loaded. An import
   * that takes hours needs to be watchable while it runs, so this is the
   * endpoint the page polls.
   *
   * The counters are enough for the bar and nothing more: the page does
   * not re-render itself from this, it reads the numbers.
   *
   * A finished job answers 204 rather than a body with zeros. That is how
   * the page knows to stop polling — a job that is over has no progress
   * left to report, and a client that kept polling a finished job would
   * be asking the database for nothing forever.
   */
  app.get<{ Params: { id: string } }>(
    "/admin/ranges/imports/:id/progress",
    { config: { rateLimit: RANGE_POLL_RATE_LIMIT } },
    async (req, reply) => {
      const id = Number((req.params as { id?: string }).id);
      if (!Number.isFinite(id) || id <= 0) return reply.code(400).send();
      const job = await readRangeImportState(app.pool, id);
      if (!job) return reply.code(404).send();
      if (job.status !== "running") return reply.code(204).send();
      return reply.send({
        id: job.id,
        mode: job.mode,
        rowsDone: job.rowsDone,
        declaredRows: job.declaredRows,
        rowsWritten: job.rowsWritten,
        preserved: job.preserved,
      });
    },
  );

  app.get("/admin/ranges", async (req, reply) => {
    const flash = consumeFlash(req, reply);
    // The list comes from the database, not from this process's memory: a
    // restart used to empty it while the files stayed on disk, so a link
    // that had worked stopped working.
    const exports = (await listRangeExports(app.pool, 10)).map((e) => ({
      ...e,
      sizeLabel: formatBytes(e.bytes),
      createdAtLabel: formatDbTimestamp(e.startedAt ?? new Date()),
      isRunning: e.status === "running",
    }));
    // The count is the one thing on this page that can fail on its own,
    // and it is allowed to: nothing else here reads `ip_ranges`. When the
    // table is locked by another session the count comes back unknown
    // instead of taking the whole page down with it.
    const currentRows = await readRangeCount(app);
    return reply.view("admin/ranges.hbs", {
      layout: "layouts/admin",
      title: req.t("admin.ranges.title"),
      exports,
      maxRows: IPQ_DEFAULT_MAX_ROWS,
      // The number the operator is asked to type. Unknown is a dash, not a
      // zero: a zero would be a number, and a number the page did not read
      // is worse than no number at all.
      currentRowsLabel: currentRows === null ? "—" : String(currentRows),
      currentRowsUnknown: currentRows === null,
      // The job is a row, not a request: a whole-library import outlives the
      // tab that started it, and this is what shows how far it got.
      imports: (await listRangeImports(app.pool, 10)).map((job) => ({
        ...job,
        // The page shows a wall clock with the zone it is in, so a reader
        // in another zone can place it — and so the `datetime` attribute
        // of the <time> element holds a date string rather than a raw
        // JavaScript Date. Same treatment as the export list above.
        startedAtLabel: formatDbTimestamp(job.startedAt),
        isRunning: job.status === "running",
        pct:
          job.declaredRows && job.declaredRows > 0
            ? Math.min(100, Math.round((job.rowsDone / job.declaredRows) * 100))
            : null,
      })),
      // The layout renders the flash partial; it reads flash.success /
      // flash.error. Passing the message under its own kind keeps the
      // partial's contract and the page free of markup for it.
      flash: flash ? { [flash.kind]: flash.message } : undefined,
      // The link to the file just produced, so the operator does not have
      // to hunt the list for it after a redirect.
      lastExport: exports[0] ?? null,
      downloadUrl: exports[0] ? `/admin/ranges/download/${exports[0].id}` : "",
      // The two ceilings, stated on the page. The operator finds out the
      // limit by failing otherwise, and the two are different: the form
      // is bounded by the request body, the chunked upload by the file.
      limitLabel: formatBytes(RANGE_BODY_LIMIT),
      ceilingLabel: formatBytes(UPLOAD_MAX_BYTES),
      req,
      csrfToken: req.csrfToken,
    });
  });

  app.post("/admin/ranges/export", async (req, reply) => {
    if (!verifyCsrfRequest(req)) return sendCsrfPage(reply, 403);
    const country = readCountry(req);
    const id = `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const targetDir = exportTargetDir(app);
    const file = path.join(exportDir(targetDir), `${id}.ipq`);
    try {
      await fs.promises.mkdir(exportDir(targetDir), { recursive: true });
    } catch (err) {
      // The directory could not be made, so no export can start. This is
      // the one failure the request can still report: the job has not
      // started, so there is no job to record.
      app.log.error({ err }, "could not create the export directory");
      setFlash(reply, "error", req.t("admin.ranges.exportFailed", { error: messageOf(err) }));
      return reply.redirect("/admin/ranges");
    }

    // The export runs detached. A library-sized export takes long enough
    // that a request held open for it is a request a proxy kills — and
    // when the proxy kills it, the export goes with it.
    await startRangeExport(app.pool, app.log, {
      id,
      filepath: file,
      countryCode: country || null,
    });
    // The audit entry goes in after the job is on record, not before: an
    // export that failed to start did not happen, and a trail that lists
    // it would be describing something that never ran.
    //
    // The country travels with it because it changes what was disclosed.
    // An export of one country and an export of the whole library are
    // different acts, and a reader of the trail has to be able to tell
    // them apart without going and looking at the file.
    req.auditAction = {
      action: "ranges.export",
      targetType: "range_export",
      targetId: id,
      metadata: { country: country || null },
    };
    app.log.info({ exportId: id, country: country || null }, "the range export started");
    setFlash(reply, "success", req.t("admin.ranges.exportStarted"));
    return reply.redirect("/admin/ranges");
  });

  app.get("/admin/ranges/download/:id", async (req, reply) => {
    const id = (req.params as { id?: string }).id ?? "";
    if (!EXPORT_ID.test(id)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    // The job record is the authority on whether an export exists. It
    // survives a restart, which the old in-process list did not.
    const entry = await readRangeExport(app.pool, id);
    if (!entry) {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send("this export is no longer listed — export again to get a fresh file");
    }
    if (entry.status !== "success") {
      // A running export has no file to send yet, and a failed one has
      // none to send at all.
      return reply
        .code(409)
        .type("text/plain; charset=utf-8")
        .send(
          entry.status === "running"
            ? "this export is still being written — come back in a moment"
            : `this export failed: ${entry.errorMessage ?? "no reason was recorded"}`,
        );
    }
    // The file's name is recorded, not its path: the install's data
    // directory can move between runs, and a path stored in the database
    // would then point nowhere.
    const targetDir = exportTargetDir(app);
    const filepath = path.join(exportDir(targetDir), path.basename(entry.filename));
    const stat = await fs.promises.stat(filepath).catch(() => null);
    if (!stat || !stat.isFile()) {
      return reply
        .code(410)
        .type("text/plain; charset=utf-8")
        .send("the export file is gone from disk — export again");
    }
    // `application/octet-stream` rather than ndjson: browsers treat an
    // unknown JSON-ish type as a document and render it, and a two-gigabyte
    // document is not a download. The extension carries the format.
    reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", String(stat.size))
      .header("Content-Disposition", `attachment; filename="ipquery-ranges-${id}.ipq"`);
    // The file is streamed, not read. A two-gigabyte file read into memory
    // is two gigabytes of heap the process does not have — and the
    // download is exactly as long as the file, which is the reason the
    // export writes to disk first.
    return reply.send(fs.createReadStream(filepath));
  });

  app.post("/admin/ranges/import", async (req, reply) => {
    if (!verifyCsrfRequest(req)) return sendCsrfPage(reply, 403);
    const body = req.body as Record<string, unknown> | undefined;

    // `uploadId` is the chunked path. The bytes are already on disk by the
    // time this runs, so they are streamed in — and removed afterwards: the
    // import is the inverse of the export and nothing about the file needs
    // to outlive it.
    //
    // This check comes first because the chunked path carries no file in
    // the request body at all. Asking for the text first would refuse
    // every chunked import with "no file was uploaded", which is exactly
    // what the browser sends.
    const uploadId = Number(body?.uploadId ?? NaN);
    if (Number.isFinite(uploadId) && uploadId > 0) {
      const state = await openUpload(app.pool, uploadId).catch(() => null);
      if (!state || !state.complete) {
        setFlash(
          reply,
          "error",
          req.t("admin.ranges.importRejected", { error: "the upload is not complete" }),
        );
        return reply.redirect("/admin/ranges");
      }
      // A replacement is the destructive direction, so it carries the same
      // guard as the form does: the operator types the number of ranges
      // currently in the table. A browser "resend" after a timeout
      // carries a stale count and is refused.
      const isReplace = String(body?.mode ?? "") === "replace";
      if (isReplace) {
        const typed = Number(body?.confirmRows ?? NaN);
        const allowed = await replacementAllowed(app, req, reply, typed);
        if (!allowed) return reply.redirect("/admin/ranges");
      }
      // One import at a time in this process. Two would fight over the
      // same rows, and a replacement must not start while a merge is
      // still writing.
      if (isRangeImportRunning()) {
        setFlash(reply, "error", req.t("admin.ranges.importBusy"));
        return reply.redirect("/admin/ranges");
      }
      // The bytes are already on disk, so the file's header can be read
      // for the row count the progress bar needs as a denominator.
      const declaredRows = await declaredRowsOfFile(state.filepath);
      // The import runs detached. The request answers as soon as the job
      // is on record — a whole-library import takes hours, and a request
      // held open for hours is a request a proxy kills.
      const importId = await startRangeImport(app.pool, app.log, {
        mode: isReplace ? "replace" : "merge",
        filepath: state.filepath,
        uploadId,
        declaredRows,
      });
      // The mode is the whole point of the record. A merge adds rows to
      // the library; a replace swaps the entire ip_ranges table for the
      // contents of the uploaded file. A reader of the trail has to be
      // able to tell those two apart without looking anywhere else, and
      // this is the only place that says which one happened.
      req.auditAction = {
        action: "ranges.import",
        targetType: "range_import",
        targetId: importId,
        metadata: { mode: isReplace ? "replace" : "merge", declaredRows },
      };
      app.log.info({ importId, uploadId, mode: isReplace ? "replace" : "merge" }, "the range import started");
      setFlash(reply, "success", req.t("admin.ranges.importStarted"));
      return reply.redirect("/admin/ranges");
    }

    const text = readUploadedText(body);
    if (text === null) {
      // Not a flash: the operator has to see this next to the field they
      // used, and a redirect would lose it.
      return reply.code(400).type("text/plain; charset=utf-8").send("no file was uploaded");
    }
    if (Buffer.byteLength(text, "utf8") > RANGE_BODY_LIMIT) {
      setFlash(
        reply,
        "error",
        req.t("admin.ranges.tooLarge", {
          limit: formatBytes(RANGE_BODY_LIMIT),
          ceiling: formatBytes(UPLOAD_MAX_BYTES),
        }),
      );
      return reply.redirect("/admin/ranges");
    }
    // Replacement is the destructive direction, so it is gated on more than
    // a select: the operator types the number of ranges currently in the
    // table, which the page shows them. A repost of this form — a browser
    // "resend" after a timeout — carries a stale count and is refused.
    const isReplace = String(body?.mode ?? "") === "replace";
    if (isReplace) {
      const typed = Number(body?.confirmRows ?? NaN);
      const allowed = await replacementAllowed(app, req, reply, typed);
      if (!allowed) return reply.redirect("/admin/ranges");
    }
    if (isRangeImportRunning()) {
      setFlash(reply, "error", req.t("admin.ranges.importBusy"));
      return reply.redirect("/admin/ranges");
    }

    // The small-file path. The text is already in memory — it arrived as
    // a form field — but it still goes through the same job as the
    // chunked path: one import at a time, one way to watch it, one
    // place that records how it ended.
    //
    // A malformed file is refused here rather than in the job: the
    // operator is still on the page, and a redirect that says "bad file"
    // is more use than a job that fails a second later.
    let decoded;
    try {
      decoded = decodeFile(text);
    } catch (err) {
      const detail = err instanceof RangeFileError ? err.message : messageOf(err);
      setFlash(reply, "error", req.t("admin.ranges.importRejected", { error: detail }));
      return reply.redirect("/admin/ranges");
    }

    const filepath = await stageImportFile(text);
    const importId = await startRangeImport(app.pool, app.log, {
      mode: isReplace ? "replace" : "merge",
      filepath,
      uploadId: null,
      declaredRows: declaredRowCount(text),
    });
    // The same record as the chunked path writes: one import, one trail
    // entry, and the mode that says whether the library was replaced.
    req.auditAction = {
      action: "ranges.import",
      targetType: "range_import",
      targetId: importId,
      metadata: { mode: isReplace ? "replace" : "merge", declaredRows: declaredRowCount(text) },
    };
    app.log.info(
      { importId, mode: isReplace ? "replace" : "merge", rows: decoded.ranges.length },
      "the range import started",
    );
    setFlash(reply, "success", req.t("admin.ranges.importStarted"));
    return reply.redirect("/admin/ranges");
  });
}

/** The file arrives either as a `file` field with a filename (curl,
 *  tests), or as a plain field whose value is the file's text. Both are the
 *  same content once decoded. */
function readUploadedText(body: Record<string, unknown> | undefined): string | null {
  if (!body) return null;
  const candidates = [body.file, body.content, body.text];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  const files = body.files;
  if (Array.isArray(files)) {
    for (const f of files) {
      if (typeof f === "string" && f.length > 0) return f;
    }
  }
  return null;
}

/** Rows currently in the live table. Shown on the page and required as the
 *  confirmation for a replacement.
 *
 *  This one deliberately stays exact. The replacement form makes the operator
 *  type this number as the safety gate, and the POST compares it against a
 *  freshly counted value — an estimate here would make a correct operator fail
 *  the gate. The page that renders it is an admin tool used rarely, and it
 *  already does real work; a couple of seconds on that one form is the cost of
 *  a gate that cannot be satisfied by guessing. */
async function countRanges(app: FastifyInstance): Promise<number> {
  const [rows] = await app.pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM ip_ranges",
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The row count, or null when it cannot be read.
 *
 * `ip_ranges` is the table every other session wants: the ETL swaps it
 * under a RENAME, a hand-run UPDATE takes a write lock on it, a leftover
 * transaction holds one. When that happens the count waits for the
 * metadata lock until `lock_wait_timeout` and then throws
 * ER_LOCK_WAIT_TIMEOUT.
 *
 * The two callers treat that differently, because the count means different
 * things to them. On the page it is a nicety — the export list, the import
 * history and both forms do not depend on it — so it is allowed to be
 * missing. In the replacement gate it is the whole point, so it is not.
 */
async function readRangeCount(app: FastifyInstance): Promise<number | null> {
  try {
    return await countRanges(app);
  } catch (err) {
    app.log.warn({ err }, "the ip_ranges row count could not be read");
    return null;
  }
}

/**
 * The replacement gate.
 *
 * The operator types the number of ranges currently in the library, and it
 * is compared against a freshly counted one: a browser resend of the form
 * carries the count from before the first replacement, and refusing is the
 * whole point of the gate.
 *
 * There are two ways to refuse, and the operator needs to be told which
 * one happened. The number they typed does not match — they get the
 * current count back so they can type it. Or the count cannot be read at
 * all, because the table is locked by another session: then there is
 * nothing to compare against, the gate stays shut, and saying so is the
 * difference between "your confirmation was wrong" and "the database is
 * busy" — otherwise the operator blames their own number.
 *
 * Returns true when the replacement may proceed.
 */
async function replacementAllowed(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  typed: number,
): Promise<boolean> {
  const expected = await readRangeCount(app);
  if (expected === null) {
    setFlash(reply, "error", req.t("admin.ranges.replace.countUnavailable"));
    return false;
  }
  if (!Number.isFinite(typed) || typed !== expected) {
    setFlash(reply, "error", req.t("admin.ranges.replace.mismatch", { expected }));
    return false;
  }
  return true;
}

/** The row count the header declares. A file that cannot say is left null —
 *  a bar with no denominator is honest, a guessed one is not. */
function declaredRowCount(text: string): number | null {
  const first = text.split(String.fromCharCode(10))[0] ?? "";
  try {
    const parsed = JSON.parse(first) as { rows?: unknown };
    return typeof parsed.rows === "number" ? parsed.rows : null;
  } catch {
    return null;
  }
}

/** The row count the file on disk declares.
 *
 *  Only the header is read — the file can be two gigabytes, and the
 *  header is the first line. A file that cannot say is left null. */
async function declaredRowsOfFile(filepath: string): Promise<number | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filepath, "r");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split(String.fromCharCode(10))[0] ?? "";
    const parsed = JSON.parse(first) as { rows?: unknown };
    return typeof parsed.rows === "number" ? parsed.rows : null;
  } catch {
    // A file whose header cannot be read is a file the import will reject
    // anyway; the job records why.
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function readCountry(req: FastifyRequest): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const raw = body?.country;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toUpperCase();
  // The column is CHAR(2). Anything else would silently match nothing.
  return /^[A-Z]{2}$/.test(value) ? value : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

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
import * as path from "node:path";
import { verifyCsrfRequest } from "../plugins/csrf";
import { sendCsrfPage } from "../errors/render";
import { exportRangesToFile } from "../../storage/rangeExport";
import { importRanges } from "../../storage/rangeImport";
import { decodeFile, RangeFileError, IPQ_DEFAULT_MAX_ROWS } from "../../storage/rangeFile";

const FLASH_COOKIE = "ranges_flash";

/** The paste field is bounded so a stray multi-megabyte body is refused by
 *  Fastify's own limit rather than parsed first. */
const MAX_PASTE_BYTES = 16 * 1024 * 1024;

export interface RangeExportState {
  readonly id: string;
  readonly file: string;
  readonly rows: number;
  readonly bytes: number;
  readonly createdAt: number;
}

/** Exports written by this process. A restart clears the list; the files
 *  stay on disk, so a download link that is still valid keeps working. */
const exportState = new Map<string, RangeExportState>();

function exportDir(dataDir: string): string {
  return path.join(dataDir, "exports");
}

/** Generated names only — a caller never supplies the path that is opened. */
const EXPORT_ID = /^[a-z0-9-]{8,64}$/;

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

export function registerRangeRoutes(app: FastifyInstance): void {
  app.get("/admin/ranges", async (req, reply) => {
    const flash = consumeFlash(req, reply);
    const exports = [...exportState.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map((e) => ({
        ...e,
        sizeLabel: formatBytes(e.bytes),
        createdAtLabel: new Date(e.createdAt).toISOString(),
      }));
    return reply.view("admin/ranges.hbs", {
      layout: "layouts/admin",
      title: req.t("admin.ranges.title"),
      exports,
      maxRows: IPQ_DEFAULT_MAX_ROWS,
      // The layout renders the flash partial; it reads flash.success /
      // flash.error. Passing the message under its own kind keeps the
      // partial's contract and the page free of markup for it.
      flash: flash ? { [flash.kind]: flash.message } : undefined,
      // The link to the file just produced, so the operator does not have
      // to hunt the list for it after a redirect.
      lastExport: exports[0] ?? null,
      downloadUrl: exports[0] ? `/admin/ranges/download/${exports[0].id}` : "",
      req,
      csrfToken: req.csrfToken,
    });
  });

  app.post("/admin/ranges/export", async (req, reply) => {
    if (!verifyCsrfRequest(req)) return sendCsrfPage(reply, 403);
    const country = readCountry(req);
    const id = `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const targets = [app.cfg.etl.dataDir, path.join(process.cwd(), "data")];
    const targetDir = targets[0] ?? process.cwd();
    try {
      await fs.promises.mkdir(exportDir(targetDir), { recursive: true });
      const file = path.join(exportDir(targetDir), `${id}.ipq`);
      const result = await exportRangesToFile(app.pool, file, country ? { countryCode: country } : {});
      exportState.set(id, {
        id,
        file,
        rows: result.rows,
        bytes: result.bytes,
        createdAt: Date.now(),
      });
      setFlash(reply, "success", req.t("admin.ranges.exported", { rows: result.rows }));
    } catch (err) {
      app.log.error({ err }, "range export failed");
      setFlash(reply, "error", req.t("admin.ranges.exportFailed", { error: messageOf(err) }));
    }
    return reply.redirect("/admin/ranges");
  });

  app.get("/admin/ranges/download/:id", async (req, reply) => {
    const id = (req.params as { id?: string }).id ?? "";
    if (!EXPORT_ID.test(id)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    const entry = exportState.get(id);
    if (!entry) {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send("this export is no longer listed — export again to get a fresh file");
    }
    const data = await fs.promises.readFile(entry.file).catch(() => null);
    if (!data) {
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
      .header("Content-Disposition", `attachment; filename="ipquery-ranges-${id}.ipq"`);
    return reply.send(data);
  });

  app.post("/admin/ranges/import", async (req, reply) => {
    if (!verifyCsrfRequest(req)) return sendCsrfPage(reply, 403);
    const body = req.body as Record<string, unknown> | undefined;
    const text = readUploadedText(body);
    if (text === null) {
      // Not a flash: the operator has to see this next to the field they
      // used, and a redirect would lose it.
      return reply.code(400).type("text/plain; charset=utf-8").send("no file was uploaded");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_PASTE_BYTES) {
      setFlash(reply, "error", req.t("admin.ranges.tooLarge"));
      return reply.redirect("/admin/ranges");
    }
    let decoded;
    try {
      decoded = decodeFile(text);
    } catch (err) {
      const detail = err instanceof RangeFileError ? err.message : messageOf(err);
      setFlash(reply, "error", req.t("admin.ranges.importRejected", { error: detail }));
      return reply.redirect("/admin/ranges");
    }
    try {
      const result = await importRanges(app.pool, decoded.ranges);
      setFlash(
        reply,
        result.failed > 0 ? "error" : "success",
        req.t("admin.ranges.imported", { inserted: result.inserted, failed: result.failed }),
      );
    } catch (err) {
      app.log.error({ err }, "range import failed");
      setFlash(reply, "error", req.t("admin.ranges.importFailed", { error: messageOf(err) }));
    }
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

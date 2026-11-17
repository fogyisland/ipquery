"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRangeRoutes = registerRangeRoutes;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const csrf_1 = require("../plugins/csrf");
const render_1 = require("../errors/render");
const rangeExport_1 = require("../../storage/rangeExport");
const rangeImport_1 = require("../../storage/rangeImport");
const rangeFile_1 = require("../../storage/rangeFile");
const FLASH_COOKIE = "ranges_flash";
/** The paste field is bounded so a stray multi-megabyte body is refused by
 *  Fastify's own limit rather than parsed first. */
const MAX_PASTE_BYTES = 16 * 1024 * 1024;
/** Exports written by this process. A restart clears the list; the files
 *  stay on disk, so a download link that is still valid keeps working. */
const exportState = new Map();
function exportDir(dataDir) {
    return path.join(dataDir, "exports");
}
/** Generated names only — a caller never supplies the path that is opened. */
const EXPORT_ID = /^[a-z0-9-]{8,64}$/;
function setFlash(reply, kind, message) {
    reply.setCookie(FLASH_COOKIE, JSON.stringify({ kind, message }), {
        path: "/admin/ranges",
        httpOnly: true,
        sameSite: "lax",
    });
}
function consumeFlash(req, reply) {
    const raw = req.cookies[FLASH_COOKIE];
    if (!raw)
        return undefined;
    reply.clearCookie(FLASH_COOKIE, { path: "/admin/ranges" });
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.message !== "string")
            return undefined;
        return {
            kind: parsed.kind === "error" ? "error" : "success",
            message: parsed.message,
        };
    }
    catch {
        // A malformed flash cookie is not worth an error page — drop it.
        return undefined;
    }
}
function registerRangeRoutes(app) {
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
            maxRows: rangeFile_1.IPQ_DEFAULT_MAX_ROWS,
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
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const country = readCountry(req);
        const id = `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const targets = [app.cfg.etl.dataDir, path.join(process.cwd(), "data")];
        const targetDir = targets[0] ?? process.cwd();
        try {
            await fs.promises.mkdir(exportDir(targetDir), { recursive: true });
            const file = path.join(exportDir(targetDir), `${id}.ipq`);
            const result = await (0, rangeExport_1.exportRangesToFile)(app.pool, file, country ? { countryCode: country } : {});
            exportState.set(id, {
                id,
                file,
                rows: result.rows,
                bytes: result.bytes,
                createdAt: Date.now(),
            });
            setFlash(reply, "success", req.t("admin.ranges.exported", { rows: result.rows }));
        }
        catch (err) {
            app.log.error({ err }, "range export failed");
            setFlash(reply, "error", req.t("admin.ranges.exportFailed", { error: messageOf(err) }));
        }
        return reply.redirect("/admin/ranges");
    });
    app.get("/admin/ranges/download/:id", async (req, reply) => {
        const id = req.params.id ?? "";
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
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const body = req.body;
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
            decoded = (0, rangeFile_1.decodeFile)(text);
        }
        catch (err) {
            const detail = err instanceof rangeFile_1.RangeFileError ? err.message : messageOf(err);
            setFlash(reply, "error", req.t("admin.ranges.importRejected", { error: detail }));
            return reply.redirect("/admin/ranges");
        }
        try {
            const result = await (0, rangeImport_1.importRanges)(app.pool, decoded.ranges);
            setFlash(reply, result.failed > 0 ? "error" : "success", req.t("admin.ranges.imported", { inserted: result.inserted, failed: result.failed }));
        }
        catch (err) {
            app.log.error({ err }, "range import failed");
            setFlash(reply, "error", req.t("admin.ranges.importFailed", { error: messageOf(err) }));
        }
        return reply.redirect("/admin/ranges");
    });
}
/** The file arrives either as a `file` field with a filename (curl,
 *  tests), or as a plain field whose value is the file's text. Both are the
 *  same content once decoded. */
function readUploadedText(body) {
    if (!body)
        return null;
    const candidates = [body.file, body.content, body.text];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.length > 0)
            return candidate;
    }
    const files = body.files;
    if (Array.isArray(files)) {
        for (const f of files) {
            if (typeof f === "string" && f.length > 0)
                return f;
        }
    }
    return null;
}
function readCountry(req) {
    const body = req.body;
    const raw = body?.country;
    if (typeof raw !== "string")
        return undefined;
    const value = raw.trim().toUpperCase();
    // The column is CHAR(2). Anything else would silently match nothing.
    return /^[A-Z]{2}$/.test(value) ? value : undefined;
}
function messageOf(err) {
    return err instanceof Error ? err.message : String(err);
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
//# sourceMappingURL=adminRanges.js.map
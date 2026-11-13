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
exports.default = adminRoutes;
const config_1 = require("../../config");
const node_crypto_1 = require("node:crypto");
const users_1 = require("../../storage/users");
const password_1 = require("../auth/password");
const csrf_1 = require("../plugins/csrf");
const pipeline_1 = require("../../etl/pipeline");
const mysql_1 = require("../../storage/mysql");
const unknownIpQueue_1 = require("../../storage/unknownIpQueue");
const unknownIpBackfill_1 = require("../../etl/unknownIpBackfill");
const randomIpGenerator_1 = require("../../etl/randomIpGenerator");
const render_1 = require("../errors/render");
const ingestProviders_1 = require("../../storage/ingestProviders");
const randomProbeLog_1 = require("../../storage/randomProbeLog");
const unknownIpQueue_2 = require("../../storage/unknownIpQueue");
const providerErrorLog_1 = require("../../storage/providerErrorLog");
const apiKeys_1 = require("../../storage/apiKeys");
const queryLog_1 = require("../../storage/queryLog");
const auditLog_1 = require("../../storage/auditLog");
const overview_1 = require("../admin/overview");
const queries_1 = require("../admin/queries");
const queryString_1 = require("../admin/queryString");
const csv_1 = require("../admin/csv");
const mysql_2 = require("../../storage/mysql");
const runGuard_1 = require("../../etl/runGuard");
const ssrf_1 = require("../../storage/ssrf");
const genericHttpProvider_1 = require("../../etl/genericHttpProvider");
// /admin/* is already gated by the auth guard in src/web/plugins/auth.ts:
// non-admins are 403-redirected before this handler runs, so req.user is
// guaranteed to be an admin here.
/** Scan a provider's freeQuota string for the first integer and treat it
 *  as a per-minute request quota. Returns 0 when no number is found.
 *  Handles "45 req/min", "60 req/min", "1000 req/day" (the day case
 *  gets divided further down for the daily %), and skips strings like
 *  "no key (HTTP only)" entirely. Used to render the
 *  "today's quota X%" pill on the Providers tab. */
function parseFreeQuotaPerMinute(providerName) {
    const quota = ingestProviders_1.PROVIDER_CATALOG[providerName]?.freeQuota ?? "";
    const m = quota.match(/([\d,]+)/);
    if (!m)
        return 0;
    const raw = m[1];
    if (!raw)
        return 0;
    const n = Number(raw.replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
}
// ─── Backfill preview cookie (PR3: diff-preview-before-commit) ───────────
//
// The preview-before-commit flow keeps a signed cookie with the would-be
// rows for 60s so the operator can review them before any ip_ranges write.
// Cookie shape: base64url(JSON.stringify({ p: '<json payload>', s: '<hex sig>' })).
// Payload shape: { runAt: <ms>, rows: BackfillPreviewRow[], batchLimit, token }.
//
// We sign ourselves rather than using Fastify's `signed: true` because
// our payload contains nested JSON arrays of provider results; @fastify/cookie's
// built-in signing only protects the literal cookie string, but we want a
// stable, parseable schema for tests + easier debugging.
const BACKFILL_PREVIEW_COOKIE = "backfill_preview";
const BACKFILL_PREVIEW_MAX_AGE_MS = 60 * 1000;
const BACKFILL_PREVIEW_COOKIE_PATH = "/admin/ingest/backfill";
const HMAC_KEY = process.env.SESSION_SECRET || process.env.CSRF_SECRET || "dev-fallback-backfill-preview";
// Short-lived cookie carrying the outcome of an ETL trigger attempt
// across the redirect. The cookie is HTTP-only, single-use (consumed and
// cleared on the next admin page render) and carries only a fixed
// "kind" — never free text — so a tampered cookie can at worst make the
// page show the wrong canned message, not inject markup.
const ETL_FLASH_COOKIE = "etl_flash";
/**
 * Rate limit for the admin polling endpoints.
 *
 * The admin UI polls four endpoints on a timer: the ETL run-detail
 * page polls /live every 5s and /progress every 2s, and the dashboard
 * and query-log pages poll every 30s. Together the ETL page alone
 * spends 42 requests per minute.
 *
 * The global limit is 60/minute, shared with the public API by source
 * IP. An admin with the ETL page open would use 70% of the global
 * budget on polling alone, and a few ordinary page loads would push
 * the IP over — after which every poll returns 429. htmx keeps
 * polling on a 429 (it only stops on a non-2xx that isn't 429 in some
 * configurations, and a 429 body is not a 204 "no content"), so the
 * progress bar freezes while the page keeps hammering.
 *
 * A route-level `config.rateLimit` object REPLACES the global setting
 * and gets its own counter (see @fastify/rate-limit's `onRoute` hook:
 * a route with a custom config gets `store.child(...)` and the global
 * hook is not attached to it). So these routes stop consuming the
 * public API's budget at all.
 *
 * The limit is still finite: 120/minute is twice the worst-case poll
 * rate (60/min for the two ETL endpoints together) with headroom for
 * a couple of open tabs, and it bounds what a hijacked admin session
 * can spend.
 */
const ADMIN_POLL_RATE_LIMIT = {
    max: 120,
    timeWindow: "1 minute",
};
/**
 * Read and clear the ETL flash cookie, turning it into the shape the
 * `flash` partial expects ({ success } / { error } / ...).
 *
 * Returns undefined when there is no flash to show.
 */
function consumeEtlFlash(req, reply, t) {
    const raw = req.cookies[ETL_FLASH_COOKIE];
    if (!raw)
        return undefined;
    reply.clearCookie(ETL_FLASH_COOKIE, { path: "/admin" });
    let kind;
    try {
        kind = JSON.parse(raw).kind;
    }
    catch {
        // A malformed cookie is not worth an error page — just drop it.
        return undefined;
    }
    if (kind === "alreadyRunning") {
        return { error: t("admin.etl.alreadyRunning") };
    }
    return undefined;
}
function hmacSign(payloadJson) {
    return (0, node_crypto_1.createHmac)("sha256", HMAC_KEY).update(payloadJson).digest("hex");
}
function signBackfillPreview(payload) {
    const json = JSON.stringify(payload);
    const sig = hmacSign(json);
    return Buffer.from(JSON.stringify({ p: json, s: sig })).toString("base64url");
}
function verifyBackfillPreview(cookie) {
    if (!cookie)
        return { ok: false, reason: "missing" };
    let envelope;
    try {
        envelope = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8"));
    }
    catch {
        return { ok: false, reason: "tampered" };
    }
    if (!envelope || typeof envelope.p !== "string" || typeof envelope.s !== "string") {
        return { ok: false, reason: "tampered" };
    }
    // Verify HMAC with timingSafeEqual to defeat timing attacks.
    const expected = hmacSign(envelope.p);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(envelope.s, "hex");
    if (a.length !== b.length || !(0, node_crypto_1.timingSafeEqual)(a, b)) {
        return { ok: false, reason: "tampered" };
    }
    let payload;
    try {
        payload = JSON.parse(envelope.p);
    }
    catch {
        return { ok: false, reason: "tampered" };
    }
    if (!payload ||
        typeof payload.runAt !== "number" ||
        !Array.isArray(payload.rows) ||
        typeof payload.batchLimit !== "number" ||
        typeof payload.token !== "string") {
        return { ok: false, reason: "tampered" };
    }
    if (Date.now() - payload.runAt > BACKFILL_PREVIEW_MAX_AGE_MS) {
        return { ok: false, reason: "expired" };
    }
    return { ok: true, payload };
}
async function adminRoutes(app) {
    app.get("/admin", { config: { rateLimit: ADMIN_POLL_RATE_LIMIT } }, async (req, reply) => {
        const overview = await (0, overview_1.getOverview)(app.pool);
        return reply.view("admin/dashboard.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.dashboard.title"),
            overview,
            csrfToken: req.csrfToken,
            req,
        });
    });
    app.get("/admin/users", async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["role", "disabled", "verified", "search"],
            sort: ["id", "created_at", "email"],
        });
        const where = [];
        const params = [];
        if (q.filters.role) {
            where.push("role = ?");
            params.push(q.filters.role);
        }
        if (q.filters.disabled) {
            where.push("is_disabled = ?");
            params.push(Number(q.filters.disabled));
        }
        if (q.filters.verified) {
            where.push("email_verified = ?");
            params.push(Number(q.filters.verified));
        }
        if (q.filters.search) {
            where.push("email LIKE ?");
            params.push(`%${q.filters.search}%`);
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const orderBy = q.sort
            ? `ORDER BY ${q.sort.col} ${q.sort.dir === "desc" ? "DESC" : "ASC"}`
            : "ORDER BY id DESC";
        const offset = (q.page - 1) * q.limit;
        const [rows] = await app.pool.query(`SELECT * FROM users ${whereSql} ${orderBy} LIMIT ? OFFSET ?`, [...params, q.limit, offset]);
        const [totalRows] = await app.pool.query(`SELECT COUNT(*) AS c FROM users ${whereSql}`, params);
        const total = Number(totalRows[0].c);
        return reply.view("admin/users-list.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.users.title"),
            users: rows,
            page: q.page,
            totalPages: Math.max(1, Math.ceil(total / q.limit)),
            filters: q.filters,
            sort: q.sort,
            req,
            csrfToken: req.csrfToken,
        });
    });
    app.get("/admin/users.csv", async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["role", "disabled", "verified", "search"],
            sort: ["id", "created_at"],
        });
        const where = [];
        const params = [];
        if (q.filters.role) {
            where.push("role = ?");
            params.push(q.filters.role);
        }
        if (q.filters.disabled) {
            where.push("is_disabled = ?");
            params.push(Number(q.filters.disabled));
        }
        if (q.filters.search) {
            where.push("email LIKE ?");
            params.push(`%${q.filters.search}%`);
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const orderBy = q.sort
            ? `ORDER BY ${q.sort.col} ${q.sort.dir === "desc" ? "DESC" : "ASC"}`
            : "ORDER BY id DESC";
        const [rows] = await app.pool.query(`SELECT * FROM users ${whereSql} ${orderBy}`, params);
        const csv = (0, csv_1.withBom)((0, csv_1.csvForRows)(rows, [
            { header: "id", get: (r) => r.id },
            { header: "email", get: (r) => r.email },
            { header: "role", get: (r) => r.role },
            { header: "email_verified", get: (r) => r.email_verified },
            { header: "is_disabled", get: (r) => r.is_disabled },
            { header: "created_at", get: (r) => r.created_at.toISOString() },
        ]));
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="users.csv"');
        return csv;
    });
    app.post("/admin/users/bulk", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const body = req.body;
        const ids = (body.ids ?? "")
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0)
            .slice(0, 100);
        if (ids.length === 0)
            return reply.redirect("/admin/users");
        req.auditAction = {
            action: `user.bulk.${body.action}`,
            targetType: "user",
            metadata: { ids, count: ids.length },
        };
        if (body.action === "disable") {
            await app.pool.query("UPDATE users SET is_disabled = 1 WHERE id IN (?)", [ids]);
        }
        else if (body.action === "enable") {
            await app.pool.query("UPDATE users SET is_disabled = 0 WHERE id IN (?)", [ids]);
        }
        else if (body.action === "verify") {
            await app.pool.query("UPDATE users SET email_verified = 1 WHERE id IN (?)", [ids]);
        }
        else {
            return reply.code(400).send({ error: "unknown action" });
        }
        return reply.redirect("/admin/users");
    });
    app.get("/admin/users/:id", async (req, reply) => {
        const u = await (0, users_1.findUserById)(app.pool, Number(req.params.id));
        if (!u)
            return (0, render_1.sendErrorPage)(reply, 404, "notFound");
        return reply.view("admin/user-detail.hbs", { layout: "layouts/admin", title: u.email, user: u, req });
    });
    app.post("/admin/users/:id/enable", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        await (0, users_1.setDisabled)(app.pool, Number(req.params.id), false);
        return reply.redirect("/admin/users/" + req.params.id);
    });
    app.post("/admin/users/:id/disable", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        await (0, users_1.setDisabled)(app.pool, Number(req.params.id), true);
        return reply.redirect("/admin/users/" + req.params.id);
    });
    app.post("/admin/users/:id/verify-email", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "user.verify_email", targetType: "user", targetId: Number(req.params.id) };
        await (0, users_1.markEmailVerified)(app.pool, Number(req.params.id));
        return reply.redirect("/admin/users/" + req.params.id);
    });
    app.post("/admin/users/:id/reset-password", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "user.reset_password", targetType: "user", targetId: Number(req.params.id) };
        const id = Number(req.params.id);
        const tempPassword = `Temp${Math.random().toString(36).slice(2, 10)}1`;
        await (0, users_1.updatePassword)(app.pool, id, await (0, password_1.hashPassword)(tempPassword));
        // Render the user-detail page with tempPassword in context so the admin
        // can copy it. The field is only set on this single render and is gone
        // on the next GET (req.t resolves to undefined since it's not in context).
        const u = await (0, users_1.findUserById)(app.pool, id);
        if (!u)
            return (0, render_1.sendErrorPage)(reply, 404, "notFound");
        return reply.view("admin/user-detail.hbs", {
            layout: "layouts/admin",
            title: u.email,
            user: u,
            tempPassword,
            req,
        });
    });
    app.post("/admin/users/:id/delete", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "user.delete", targetType: "user", targetId: Number(req.params.id) };
        await (0, users_1.deleteUser)(app.pool, Number(req.params.id));
        return reply.redirect("/admin/users");
    });
    app.get("/admin/users/:id/delete/confirm", async (req, reply) => {
        const u = await (0, users_1.findUserById)(app.pool, Number(req.params.id));
        if (!u)
            return (0, render_1.sendErrorPage)(reply, 404, "notFound");
        return reply.view("admin/user-delete-confirm.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.users.delete.confirm.title"),
            user: u,
            req,
        });
    });
    app.get("/admin/etl", async (_req, reply) => reply.redirect("/admin/etl/runs"));
    app.get("/admin/etl/runs", async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["status", "since", "until"],
            sort: ["id", "started_at"],
        });
        const where = [];
        const params = [];
        if (q.filters.status) {
            where.push("status = ?");
            params.push(q.filters.status);
        }
        if (q.filters.since) {
            where.push("started_at >= ?");
            params.push(new Date(q.filters.since));
        }
        if (q.filters.until) {
            where.push("started_at <= ?");
            params.push(new Date(q.filters.until));
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const orderBy = q.sort
            ? `ORDER BY ${q.sort.col} ${q.sort.dir === "desc" ? "DESC" : "ASC"}`
            : "ORDER BY id DESC";
        const offset = (q.page - 1) * q.limit;
        const [rows] = await app.pool.query(`SELECT * FROM etl_runs ${whereSql} ${orderBy} LIMIT ? OFFSET ?`, [...params, q.limit, offset]);
        const [totalRows] = await app.pool.query(`SELECT COUNT(*) AS c FROM etl_runs ${whereSql}`, params);
        const total = Number(totalRows[0].c);
        return reply.view("admin/etl-runs.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.etl.title"),
            runs: rows,
            page: q.page,
            totalPages: Math.max(1, Math.ceil(total / q.limit)),
            filters: q.filters,
            sort: q.sort,
            flash: consumeEtlFlash(req, reply, req.t),
            req,
            csrfToken: req.csrfToken,
        });
    });
    app.get("/admin/etl/runs.csv", async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["status", "since", "until"],
            sort: ["id", "started_at"],
        });
        const where = [];
        const params = [];
        if (q.filters.status) {
            where.push("status = ?");
            params.push(q.filters.status);
        }
        if (q.filters.since) {
            where.push("started_at >= ?");
            params.push(new Date(q.filters.since));
        }
        if (q.filters.until) {
            where.push("started_at <= ?");
            params.push(new Date(q.filters.until));
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const orderBy = q.sort
            ? `ORDER BY ${q.sort.col} ${q.sort.dir === "desc" ? "DESC" : "ASC"}`
            : "ORDER BY id DESC";
        const [rows] = await app.pool.query(`SELECT * FROM etl_runs ${whereSql} ${orderBy}`, params);
        const csv = (0, csv_1.withBom)((0, csv_1.csvForRows)(rows, [
            { header: "id", get: (r) => r.id },
            { header: "started_at", get: (r) => r.started_at.toISOString() },
            { header: "finished_at", get: (r) => (r.finished_at ? r.finished_at.toISOString() : "") },
            { header: "status", get: (r) => r.status },
            { header: "maxmind_records", get: (r) => r.maxmind_records ?? "" },
            { header: "ip2region_records", get: (r) => r.ip2region_records ?? "" },
            { header: "dbip_records", get: (r) => r.dbip_records ?? "" },
            { header: "merged_records", get: (r) => r.merged_records ?? "" },
            { header: "error_message", get: (r) => r.error_message ?? "" },
        ]));
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="etl-runs.csv"');
        return csv;
    });
    const buildRunDetailCtx = async (run, req, liveOnly) => {
        const id = Number(run.id);
        const [downloads, parses, inserts, swap] = await Promise.all([
            (0, mysql_2.listEtlRunDownloads)(app.pool, id),
            (0, mysql_2.listEtlRunParses)(app.pool, id),
            (0, mysql_2.listEtlRunInserts)(app.pool, id),
            (0, mysql_2.getEtlRunSwap)(app.pool, id),
        ]);
        // Aggregate across the per-file rows so the template doesn't need to
        // do any reductions. Counts and durations land as flat numeric fields;
        // per-file tables render from the row arrays unchanged.
        const bytesTotal = downloads.reduce((sum, d) => sum + (d.bytes ?? 0), 0);
        const rowsEmittedTotal = parses.reduce((sum, p) => sum + p.rowsEmitted, 0);
        const rowsSkippedTotal = parses.reduce((sum, p) => sum +
            p.rowsSkippedShort +
            p.rowsSkippedHeader +
            p.rowsSkippedUnparseableIp +
            p.rowsSkippedMissingCol +
            p.rowsSkippedNanAsn +
            p.rowsSkippedOther, 0);
        const rowsAttemptedTotal = inserts.reduce((sum, i) => sum + i.rowsAttempted, 0);
        const rowsInsertedTotal = inserts.reduce((sum, i) => sum + i.rowsInserted, 0);
        const rowsDuplicatesTotal = inserts.reduce((sum, i) => sum + i.rowsDuplicates, 0);
        const durationDownload = downloads.reduce((sum, d) => sum + (d.durationMs ?? 0), 0);
        const durationParse = parses.reduce((sum, p) => sum + (p.durationMs ?? 0), 0);
        const durationInsert = inserts.reduce((sum, i) => sum + (i.durationMs ?? 0), 0);
        const runDurationMs = run.finished_at && run.started_at
            ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
            : 0;
        // Pre-resolve every parameterized i18n string. Status / skip-reason /
        // count / duration phrases all take hash args that HBS drops on the floor.
        const statusText = req.t(`admin.etl.runDetail.status.${run.status}`);
        const runDurationText = req.t("admin.etl.runDetail.duration", { ms: runDurationMs });
        const durationDownloadText = req.t("admin.etl.stages.duration", { ms: durationDownload });
        const durationParseText = req.t("admin.etl.stages.duration", { ms: durationParse });
        const durationInsertText = req.t("admin.etl.stages.duration", { ms: durationInsert });
        const rowsSkippedText = req.t("admin.etl.stages.rowsSkipped", { count: rowsSkippedTotal });
        const rowsInsertedText = req.t("admin.etl.stages.rowsInserted", { count: rowsInsertedTotal });
        const rowsDuplicatesText = req.t("admin.etl.stages.rowsDuplicates", { count: rowsDuplicatesTotal });
        const totalBytesText = req.t("admin.etl.stages.totalBytes");
        const swapStatusText = swap
            ? req.t(swap.status === "success" ? "admin.etl.stages.swapOk" : "admin.etl.stages.swapFailed")
            : "";
        const swapDurationText = swap ? req.t("admin.etl.stages.duration", { ms: swap.durationMs ?? 0 }) : "";
        const skipLabels = {
            shortLine: req.t("admin.etl.stages.skipReason.shortLine"),
            headerRow: req.t("admin.etl.stages.skipReason.headerRow"),
            unparseableIp: req.t("admin.etl.stages.skipReason.unparseableIp"),
            missingCol: req.t("admin.etl.stages.skipReason.missingCol"),
            nonNumericAsn: req.t("admin.etl.stages.skipReason.nonNumericAsn"),
            other: req.t("admin.etl.stages.skipReason.other"),
        };
        const downloadsView = downloads.map((d) => ({
            ...d,
            statusKind: d.status === "success"
                ? "success"
                : d.status === "missing" || d.status === "skipped"
                    ? "warning"
                    : "danger",
        }));
        const parsesView = parses.map((p) => ({
            ...p,
            skippedTotal: p.rowsSkippedShort +
                p.rowsSkippedHeader +
                p.rowsSkippedUnparseableIp +
                p.rowsSkippedMissingCol +
                p.rowsSkippedNanAsn +
                p.rowsSkippedOther,
            skipLabels,
        }));
        const swapRow = swap ? { ...swap, statusText: swapStatusText, durationText: swapDurationText } : null;
        return {
            run,
            runDurationMs,
            runDurationText,
            statusText,
            downloads: downloadsView,
            parses: parsesView,
            inserts,
            swap: swapRow,
            bytesTotal,
            rowsEmittedTotal,
            rowsSkippedTotal,
            rowsSkippedText,
            rowsAttemptedTotal,
            rowsInsertedTotal,
            rowsInsertedText,
            rowsDuplicatesTotal,
            rowsDuplicatesText,
            totalBytesText,
            durationDownload,
            durationDownloadText,
            durationParse,
            durationParseText,
            durationInsert,
            durationInsertText,
            // Live-progress bar state. Pulled from the run row (the pipeline
            // keeps these columns current via EtlProgressSink). The template
            // renders these on the full page and on every /live swap so the
            // bar widths move smoothly without a JSON round-trip — the JSON
            // endpoint is only used by the dedicated progress sub-section
            // that polls every 2s and reports per-byte counters.
            downloadBytesDone: Number(run.download_bytes_done ?? 0),
            downloadBytesTotal: Number(run.download_bytes_total ?? 0),
            insertRowsDone: Number(run.insert_rows_done ?? 0),
            insertRowsTotal: Number(run.insert_rows_total ?? 0),
            currentStage: run.current_stage ?? null,
            liveOnly,
            req,
        };
    };
    app.get("/admin/etl/runs/:id", async (req, reply) => {
        const id = Number(req.params.id);
        const [rows] = await app.pool.query("SELECT * FROM etl_runs WHERE id = ?", [id]);
        const run = rows[0];
        if (!run)
            return (0, render_1.sendErrorPage)(reply, 404, "notFound");
        const ctx = await buildRunDetailCtx(run, req, false);
        return reply.view("admin/etl-run-detail.hbs", {
            ...ctx,
            layout: "layouts/admin",
            title: req.t("admin.etl.detail.title", { id: run.id }),
        });
    });
    // Live-polling endpoint. When the run is still in flight, render the
    // same template with `liveOnly` set so the only thing in the response is
    // the bare <section class="etl-stage-live"> wrapper (everything else is
    // conditionally suppressed). HTMX's hx-select="section" then picks up
    // just that wrapper for outerHTML swap; because the swapped-in section
    // carries no hx-get/hx-trigger attribute of its own, polling terminates
    // naturally. When the run has finished we return 204 as a no-op.
    app.get("/admin/etl/runs/:id/live", { config: { rateLimit: ADMIN_POLL_RATE_LIMIT } }, async (req, reply) => {
        const id = Number(req.params.id);
        const [rows] = await app.pool.query("SELECT * FROM etl_runs WHERE id = ?", [id]);
        const run = rows[0];
        if (!run)
            return reply.code(204).send();
        if (run.status !== "running")
            return reply.code(204).send();
        const ctx = await buildRunDetailCtx(run, req, true);
        return reply.view("admin/etl-run-detail.hbs", {
            ...ctx,
            title: req.t("admin.etl.detail.title", { id: run.id }),
        });
    });
    // Lightweight JSON endpoint backing the new progress bars on the
    // run-detail page. Returns only the four numeric counters + stage so
    // the client can update the bars without re-rendering the whole page.
    // When the run finishes the page stops polling; the server returns
    // 204 in that case so htmx interprets it as "no swap".
    app.get("/admin/etl/runs/:id/progress", { config: { rateLimit: ADMIN_POLL_RATE_LIMIT } }, async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send();
        const progress = await (0, mysql_1.getEtlRunProgress)(app.pool, id);
        if (!progress)
            return reply.code(404).send();
        if (progress.status !== "running")
            return reply.code(204).send();
        return reply.send({
            runId: id,
            status: progress.status,
            currentStage: progress.currentStage,
            downloadBytesDone: progress.downloadBytesDone,
            downloadBytesTotal: progress.downloadBytesTotal,
            insertRowsDone: progress.insertRowsDone,
            insertRowsTotal: progress.insertRowsTotal,
            progressUpdatedAt: progress.progressUpdatedAt instanceof Date
                ? progress.progressUpdatedAt.toISOString()
                : progress.progressUpdatedAt,
            errorMessage: progress.errorMessage,
        });
    });
    app.post("/admin/etl/trigger", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "etl.trigger", targetType: "etl_run" };
        // Refuse early if an ETL is already running. The pipeline takes the
        // same lock itself (that is the cross-process guarantee), but by
        // then it would already have a 'running' etl_runs row to fail and
        // clean up. Checking here lets us tell the admin *why* nothing
        // happened instead of leaving a half-started run behind.
        const runningRunId = await (0, runGuard_1.findRunningEtlRun)(app.pool);
        if (runningRunId !== null) {
            reply.setCookie("etl_flash", JSON.stringify({ kind: "alreadyRunning" }), {
                path: "/admin",
                maxAge: 30,
                httpOnly: true,
                sameSite: "lax",
            });
            return reply.redirect(`/admin/etl/runs/${runningRunId}?live=1`);
        }
        // Insert the etl_runs row up-front so we can redirect to the live
        // detail page (which auto-polls /live every 5s). runPipeline() reuses
        // the runId when one is passed in, so the row created here is the
        // same one the pipeline will finalise. If the pipeline ever throws
        // before recordEtlStart() fires, recordEtlFinish marks this row as
        // 'failed' with the error message, so the redirect target is always
        // meaningful.
        let runId;
        try {
            runId = await (0, mysql_1.recordEtlStart)(app.pool);
        }
        catch (err) {
            req.log.error({ err }, "etl.trigger: recordEtlStart failed");
            return (0, render_1.sendCsrfPage)(reply, 503);
        }
        void (0, pipeline_1.runPipeline)({ cfg: app.cfg, runId }).catch((err) => {
            req.log.error({ err }, "manual ETL failed");
            // The pipeline refused to start (another process holds the lock).
            // The run row we created above stays at status='running' forever
            // unless we close it out, so mark it failed here.
            void (0, mysql_2.recordEtlFinish)(app.pool, runId, "failed", {
                errorMessage: err instanceof Error ? err.message : String(err),
            }).catch((finishErr) => {
                req.log.error({ err: finishErr }, "etl.trigger: failed to close out the run row");
            });
        });
        return reply.redirect(`/admin/etl/runs/${runId}?live=1`);
    });
    app.get("/admin/etl/trigger/confirm", async (req, reply) => {
        return reply.view("admin/etl-trigger-confirm.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.etl.trigger.confirm.title"),
            req,
        });
    });
    app.get("/admin/keys", async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["revoked", "userId"],
            sort: ["id", "created_at", "revoked_at"],
        });
        const userId = q.filters.userId ? Number(q.filters.userId) : undefined;
        const limit = q.limit;
        const offset = (q.page - 1) * limit;
        const { rows, total } = await (0, apiKeys_1.listAllApiKeys)(app.pool, { offset, limit, userId });
        // The brief's columns are id, user_email, label, key_prefix, created_at, revoked_at.
        // For the HTML view we apply the revoked filter client-side because listAllApiKeys
        // doesn't expose a `revoked` predicate; we re-run a fresh JOIN query that does.
        let filtered = rows;
        if (q.filters.revoked) {
            const want = q.filters.revoked === "yes" ? 1 : 0;
            filtered = rows.filter((k) => (k.revokedAt ? 1 : 0) === want);
        }
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const queryParts = [];
        if (q.filters.revoked)
            queryParts.push(`revoked=${encodeURIComponent(q.filters.revoked)}`);
        if (q.filters.userId)
            queryParts.push(`userId=${encodeURIComponent(q.filters.userId)}`);
        if (q.sort)
            queryParts.push(`sort=${q.sort.dir === "desc" ? "-" : ""}${q.sort.col}`);
        const queryString = queryParts.join("&");
        return reply.view("admin/keys.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.keys.title"),
            keys: filtered,
            page: q.page,
            totalPages,
            userId: q.filters.userId ?? "",
            queryString,
            filters: q.filters,
            sort: q.sort,
            req,
            csrfToken: req.csrfToken,
        });
    });
    app.get("/admin/keys.csv", async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["revoked", "userId"],
            sort: ["id", "created_at", "revoked_at"],
        });
        const where = [];
        const params = [];
        if (q.filters.revoked === "yes") {
            where.push("k.revoked_at IS NOT NULL");
        }
        else if (q.filters.revoked === "no") {
            where.push("k.revoked_at IS NULL");
        }
        if (q.filters.userId) {
            where.push("k.user_id = ?");
            params.push(Number(q.filters.userId));
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const orderBy = q.sort
            ? `ORDER BY k.${q.sort.col} ${q.sort.dir === "desc" ? "DESC" : "ASC"}`
            : "ORDER BY k.id DESC";
        const [rows] = await app.pool.query(`SELECT k.*, u.email AS owner_email FROM api_keys k JOIN users u ON u.id = k.user_id ${whereSql} ${orderBy}`, params);
        const csv = (0, csv_1.withBom)((0, csv_1.csvForRows)(rows, [
            { header: "id", get: (r) => r.id },
            { header: "user_email", get: (r) => r.owner_email },
            { header: "label", get: (r) => r.label },
            { header: "key_prefix", get: (r) => r.key_prefix },
            { header: "created_at", get: (r) => r.created_at.toISOString() },
            { header: "revoked_at", get: (r) => (r.revoked_at ? r.revoked_at.toISOString() : "") },
        ]));
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="api-keys.csv"');
        return csv;
    });
    app.post("/admin/keys/:id/revoke", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "key.revoke", targetType: "api_key", targetId: Number(req.params.id) };
        await (0, apiKeys_1.revokeApiKey)(app.pool, Number(req.params.id));
        return reply.redirect("/admin/keys");
    });
    // Bulk-revoke multiple API keys at once. Admin tickes the per-row
    // checkboxes on /admin/keys and clicks "Revoke selected (N)". The
    // form posts a comma-separated `ids` list. Capped at 100 by the
    // storage helper; the route also filters non-numeric / non-positive
    // values defensively. Already-revoked keys are silently skipped by
    // the UPDATE's `revoked_at IS NULL` predicate — they're no-ops.
    app.post("/admin/keys/revoke-bulk", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const body = req.body;
        const ids = (body.ids ?? "")
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0)
            .slice(0, 100);
        if (ids.length === 0)
            return reply.redirect("/admin/keys");
        req.auditAction = {
            action: "key.bulk_revoke",
            targetType: "api_key",
            metadata: { ids, count: ids.length },
        };
        await (0, apiKeys_1.revokeApiKeysBulk)(app.pool, ids);
        return reply.redirect("/admin/keys");
    });
    app.get("/admin/audit", async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["userEmail", "status", "ipText"],
            sort: ["id", "ts"],
        });
        let userId;
        if (q.filters.userEmail) {
            const u = await (0, users_1.findUserByEmail)(app.pool, q.filters.userEmail);
            // Sentinel -1 (no user has this id) forces zero rows when the email
            // doesn't resolve — listQueryLogs filters on user_id !== undefined.
            userId = u ? u.id : -1;
        }
        const status = q.filters.status;
        const limit = q.limit;
        const offset = (q.page - 1) * limit;
        // The `sort` whitelist above ("id", "ts") is the same set the
        // storage layer accepts, so no cast is needed — and listQueryLogs
        // re-checks the column before interpolating it into ORDER BY.
        const sort = q.sort ? { col: q.sort.col, dir: q.sort.dir } : undefined;
        const { rows, total } = await (0, queryLog_1.listQueryLogs)(app.pool, {
            offset,
            limit,
            userId,
            status,
            ipText: q.filters.ipText,
            sort,
        });
        const totalPages = Math.max(1, Math.ceil(total / limit));
        // Build a queryString that preserves filter+sort state for pagination
        // links, mirroring the Task 8 keys.hbs pattern.
        const queryParts = [];
        if (q.filters.userEmail)
            queryParts.push(`userEmail=${encodeURIComponent(q.filters.userEmail)}`);
        if (q.filters.status)
            queryParts.push(`status=${encodeURIComponent(q.filters.status)}`);
        if (q.filters.ipText)
            queryParts.push(`ipText=${encodeURIComponent(q.filters.ipText)}`);
        if (q.sort)
            queryParts.push(`sort=${q.sort.dir === "desc" ? "-" : ""}${q.sort.col}`);
        const queryString = queryParts.join("&");
        return reply.view("admin/audit.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.audit.title"),
            rows,
            page: q.page,
            totalPages,
            queryString,
            filters: q.filters,
            sort: q.sort,
            req,
            csrfToken: req.csrfToken,
        });
    });
    app.get("/admin/audit.csv", async (req, reply) => {
        const q = req.query;
        let userId;
        if (q.userEmail) {
            const u = await (0, users_1.findUserByEmail)(app.pool, q.userEmail);
            userId = u ? u.id : -1;
        }
        const chunks = [];
        await (0, queryLog_1.streamQueryLogsCsv)(app.pool, { offset: 0, limit: 1_000_000, userId, status: q.status, ipText: q.ipText }, (s) => chunks.push(s));
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="audit.csv"');
        return reply.send(chunks.join(""));
    });
    app.get("/admin/audit-log", async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["action", "actor", "target_type", "since", "until"],
            sort: ["id", "created_at"],
        });
        const opts = {
            offset: (q.page - 1) * q.limit,
            limit: q.limit,
        };
        if (q.filters.action)
            opts.action = q.filters.action;
        if (q.filters.target_type)
            opts.targetType = q.filters.target_type;
        if (q.filters.since)
            opts.since = new Date(q.filters.since);
        if (q.filters.until)
            opts.until = new Date(q.filters.until);
        if (q.filters.actor) {
            const u = await (0, users_1.findUserByEmail)(app.pool, q.filters.actor);
            // Sentinel -1 (no user has this id) forces zero rows when the email
            // doesn't resolve — listAuditLog filters on actor_user_id !== undefined.
            opts.actorUserId = u ? u.id : -1;
        }
        if (q.sort)
            opts.sort = { col: q.sort.col, dir: q.sort.dir };
        const { rows, total } = await (0, auditLog_1.listAuditLog)(app.pool, opts);
        const totalPages = Math.max(1, Math.ceil(total / q.limit));
        // Build a queryString that preserves filter+sort state for pagination
        // links, mirroring the Task 8/9 pattern.
        const queryParts = [];
        if (q.filters.action)
            queryParts.push(`action=${encodeURIComponent(q.filters.action)}`);
        if (q.filters.actor)
            queryParts.push(`actor=${encodeURIComponent(q.filters.actor)}`);
        if (q.filters.target_type)
            queryParts.push(`target_type=${encodeURIComponent(q.filters.target_type)}`);
        if (q.filters.since)
            queryParts.push(`since=${encodeURIComponent(q.filters.since)}`);
        if (q.filters.until)
            queryParts.push(`until=${encodeURIComponent(q.filters.until)}`);
        if (q.sort)
            queryParts.push(`sort=${q.sort.dir === "desc" ? "-" : ""}${q.sort.col}`);
        const queryString = queryParts.join("&");
        return reply.view("admin/audit-log.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.auditLog.title"),
            rows,
            page: q.page,
            totalPages,
            queryString,
            filters: q.filters,
            sort: q.sort,
            req,
            csrfToken: req.csrfToken,
        });
    });
    app.get("/admin/audit-log.csv", async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["action", "actor", "target_type", "since", "until"],
            sort: ["id", "created_at"],
        });
        const opts = {
            offset: 0,
            limit: 1_000_000,
        };
        if (q.filters.action)
            opts.action = q.filters.action;
        if (q.filters.target_type)
            opts.targetType = q.filters.target_type;
        if (q.filters.since)
            opts.since = new Date(q.filters.since);
        if (q.filters.until)
            opts.until = new Date(q.filters.until);
        if (q.filters.actor) {
            const u = await (0, users_1.findUserByEmail)(app.pool, q.filters.actor);
            opts.actorUserId = u ? u.id : -1;
        }
        if (q.sort)
            opts.sort = { col: q.sort.col, dir: q.sort.dir };
        const { rows } = await (0, auditLog_1.listAuditLog)(app.pool, opts);
        const csv = (0, csv_1.withBom)((0, csv_1.csvForRows)(rows, [
            { header: "id", get: (r) => r.id },
            { header: "created_at", get: (r) => r.created_at.toISOString() },
            { header: "actor_email", get: (r) => r.actor_email },
            { header: "action", get: (r) => r.action },
            { header: "target_type", get: (r) => r.target_type ?? "" },
            { header: "target_id", get: (r) => r.target_id ?? "" },
            { header: "ip", get: (r) => r.ip ?? "" },
        ]));
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="audit-log.csv"');
        return csv;
    });
    app.get("/admin/queries", { config: { rateLimit: ADMIN_POLL_RATE_LIMIT } }, async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["since", "until"],
            sort: [],
        });
        const opts = {};
        if (q.filters.since)
            opts.since = new Date(q.filters.since);
        if (q.filters.until)
            opts.until = new Date(q.filters.until);
        const stats = await (0, queries_1.getQueryStats)(app.pool, opts);
        const hitRate = stats.total > 0 ? stats.byStatus.hit / stats.total : 0;
        const queryParts = [];
        if (q.filters.since)
            queryParts.push(`since=${encodeURIComponent(q.filters.since)}`);
        if (q.filters.until)
            queryParts.push(`until=${encodeURIComponent(q.filters.until)}`);
        const queryString = queryParts.join("&");
        return reply.view("admin/queries.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.queries.title"),
            stats,
            hitRate,
            filters: q.filters,
            queryString,
            req,
            csrfToken: req.csrfToken,
        });
    });
    app.get("/admin/queries.csv", async (req, reply) => {
        const q = (0, queryString_1.parseListQuery)(req.url.split("?")[1] ?? "", {
            filters: ["since", "until"],
            sort: [],
        });
        const where = [];
        const params = [];
        if (q.filters.since) {
            where.push("q.ts >= ?");
            params.push(new Date(q.filters.since));
        }
        if (q.filters.until) {
            where.push("q.ts <= ?");
            params.push(new Date(q.filters.until));
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const [rows] = await app.pool.query(`SELECT q.ts, q.ip_text, q.status, u.email AS user_email
         FROM query_log q
         LEFT JOIN users u ON u.id = q.user_id
         ${whereSql}
         ORDER BY q.ts DESC`, params);
        const csv = (0, csv_1.withBom)((0, csv_1.csvForRows)(rows, [
            { header: "ts", get: (r) => r.ts.toISOString() },
            { header: "ip_text", get: (r) => r.ip_text },
            { header: "status", get: (r) => r.status },
            { header: "user_email", get: (r) => r.user_email ?? "" },
        ]));
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="queries.csv"');
        return csv;
    });
    app.get("/admin/settings", async (req, reply) => {
        const cfg = app.cfg;
        // Secrets (db.password, web.sessionSecret, web.csrfSecret, smtp.pass,
        // maxmind.licenseKey) are redactSecret()-ed BEFORE they reach the
        // template. The eye-icon reveal toggles between the bullet mask and
        // the redacted form (first4…last4) — never the raw value. Raw secrets
        // must not exist anywhere in the rendered DOM: anything that can read
        // HTML source (DevTools, view-source, a cached page, a proxy log, or
        // an XSS in this page) would otherwise lift the live secrets.
        const display = {
            db: {
                host: cfg.db.host,
                port: cfg.db.port,
                database: cfg.db.database,
                user: cfg.db.user,
                poolSize: cfg.db.poolSize,
                password: cfg.db.password ? (0, config_1.redactSecret)(cfg.db.password) : "",
            },
            api: {
                port: cfg.api.port,
                rateLimit: cfg.api.rateLimit,
                trustProxy: cfg.api.trustProxy,
            },
            etl: { schedule: cfg.etl.schedule, timezone: cfg.etl.timezone, dataDir: cfg.etl.dataDir },
            web: {
                baseUrl: cfg.web.baseUrl,
                cookieDomain: cfg.web.cookieDomain,
                cookieSecure: cfg.web.cookieSecure,
                sessionTtlHours: cfg.web.sessionTtlHours,
                sessionSecret: cfg.web.sessionSecret ? (0, config_1.redactSecret)(cfg.web.sessionSecret) : "",
                csrfSecret: cfg.web.csrfSecret ? (0, config_1.redactSecret)(cfg.web.csrfSecret) : "",
            },
            smtp: {
                host: cfg.smtp.host || "(console)",
                port: cfg.smtp.port,
                secure: cfg.smtp.secure,
                user: cfg.smtp.user,
                pass: cfg.smtp.pass ? (0, config_1.redactSecret)(cfg.smtp.pass) : "",
                from: cfg.smtp.from,
            },
            security: { ...cfg.security },
            maxmind: {
                licenseKey: cfg.maxmind.licenseKey ? (0, config_1.redactSecret)(cfg.maxmind.licenseKey) : "",
                editions: cfg.maxmind.editions,
            },
        };
        let pool = {};
        let etlLastRun = null;
        try {
            const [poolRows] = await app.pool.query("SHOW STATUS WHERE Variable_name IN (?, ?)", [
                "Threads_connected",
                "Max_used_connections",
            ]);
            pool = Object.fromEntries(poolRows.map((r) => [
                r.Variable_name,
                r.Value,
            ]));
        }
        catch (err) {
            // Pool status is informational; do not fail the page render.
            app.log.warn({ err }, "failed to read DB pool status");
        }
        try {
            etlLastRun = await (0, mysql_2.lastEtlRun)(app.pool);
        }
        catch (err) {
            // ETL run history is informational; never fail the page on it.
            app.log.warn({ err }, "failed to read last ETL run");
        }
        // Pre-resolve the ETL status pill text + kind so the template doesn't
        // need to call req.t with hash arguments. See project memory note
        // about {{req.t key a=b}} never passing hash args through.
        let etlStatusKind = "muted";
        let etlStatusText = req.t("admin.settings.etl.lastRunNever");
        if (etlLastRun) {
            if (etlLastRun.status === "success") {
                etlStatusKind = "success";
                etlStatusText = req.t("admin.settings.etl.lastRunOk", { merged: etlLastRun.mergedRecords ?? 0 });
            }
            else if (etlLastRun.status === "failed") {
                etlStatusKind = "danger";
                etlStatusText = req.t("admin.settings.etl.lastRunFailed");
            }
            else {
                // 'running' or any future state — pending is the closest analog.
                etlStatusKind = "warning";
                etlStatusText = req.t("admin.settings.etl.lastRunRunning");
            }
        }
        return reply.view("admin/settings.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.settings.title"),
            config: display,
            pool,
            etlLastRun,
            etlStatusKind,
            etlStatusText,
            flash: consumeEtlFlash(req, reply, req.t),
            req,
            csrfToken: req.csrfToken,
        });
    });
    app.post("/admin/settings/etl-restart", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "etl.restart", targetType: "etl_run" };
        // Same guard as /admin/etl/trigger: a second concurrent run would
        // race on truncateNew + atomicSwapRanges and leave a half-populated
        // ip_ranges behind.
        const runningRunId = await (0, runGuard_1.findRunningEtlRun)(app.pool);
        if (runningRunId !== null) {
            reply.setCookie("etl_flash", JSON.stringify({ kind: "alreadyRunning" }), {
                path: "/admin",
                maxAge: 30,
                httpOnly: true,
                sameSite: "lax",
            });
            return reply.redirect("/admin/settings#integrations");
        }
        void (0, pipeline_1.runPipeline)({ cfg: app.cfg }).catch((err) => req.log.error({ err }, "manual ETL restart failed"));
        // Redirect back to the Integrations tab so the admin sees the
        // refreshed "last run" pill after the redirect.
        return reply.redirect("/admin/settings#integrations");
    });
    // ─── Ingest console (Strategy Execution surface) ───────────────────────
    // /admin/ingest shows the queue (pending + recently-processed). The
    // POST handler drains a batch via external IP geo providers + majority
    // vote, then redirects back with a summary flash. Provider keys are read
    // from env at request time so admin can rotate them without a restart.
    //
    // PR2 rename: was /admin/unknown-ips; old path is preserved as a 302
    // redirect (see redirectOld() calls at the bottom of this file).
    app.get("/admin/ingest", async (req, reply) => {
        const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
        const q = req.query;
        // The providers tab moved to /admin/providers in PR1; the union no
        // longer includes 'providers' so legacy ?tab=providers links fall
        // through to overview.
        const tab = q.tab === "failure-logs" ? q.tab : "overview";
        // Failure Logs filters — applied only when on the failure-logs tab.
        const errFilter = {};
        if (q.provider)
            errFilter.providerName = q.provider;
        if (q.errorCode)
            errFilter.errorCode = q.errorCode;
        if (q.mode === "auto" || q.mode === "manual" || q.mode === "random")
            errFilter.mode = q.mode;
        // Default "since" on Failure Logs = last 24h. Operators see recent
        // failures without paging through ancient rows.
        const sinceMs = q.since
            ? Date.parse(q.since)
            : tab === "failure-logs"
                ? Date.now() - 24 * 60 * 60 * 1000
                : undefined;
        if (sinceMs && !Number.isNaN(sinceMs))
            errFilter.sinceMs = sinceMs;
        errFilter.limit = 200;
        const [data, stats, providers, lastBackfill, errors, errorCodes, circuitBreaker, randomGenConfig, recentProbeRows, probeSummary, health1hAll, health24hAll, health7dAll, last429Rows, retentionDays,] = await Promise.all([
            (0, unknownIpQueue_1.topByQueryCount)(app.pool, limit),
            (0, unknownIpQueue_1.queueStats)(app.pool),
            (0, ingestProviders_1.listProviderConfigs)(app.pool),
            (0, ingestProviders_1.loadLastBackfillProviderStats)(app.pool),
            tab === "failure-logs" ? (0, providerErrorLog_1.queryProviderErrors)(app.pool, errFilter) : Promise.resolve([]),
            tab === "failure-logs" ? (0, providerErrorLog_1.distinctErrorCodes)(app.pool) : Promise.resolve([]),
            (0, providerErrorLog_1.getCircuitBreakerConfig)(app.pool),
            (0, randomProbeLog_1.loadRandomGenConfig)(app.pool),
            // Probe mode filter is read from the URL on the Overview tab so the
            // table can be narrowed (e.g. only auto/backfill rows). Default to
            // 'all' — the empty-state copy explains that the table shows the
            // last 20 across every mode.
            (0, randomProbeLog_1.recentProbes)(app.pool, {
                mode: q.mode === "auto" || q.mode === "manual" || q.mode === "random" ? q.mode : undefined,
                limit: 20,
            }),
            (0, randomProbeLog_1.probeSummaryStats)(app.pool, 60 * 60 * 1000),
            // 1h / 24h / 7d windowed health — same cached helper, three windows.
            // Each call returns 5 ProviderHealthWindow rows (one per catalog
            // provider), zipped by name below.
            (0, providerErrorLog_1.getAggregateProviderHealthAllCached)(app.pool, 1 * 3600 * 1000),
            (0, providerErrorLog_1.getAggregateProviderHealthAllCached)(app.pool, 24 * 3600 * 1000),
            (0, providerErrorLog_1.getAggregateProviderHealthAllCached)(app.pool, 7 * 24 * 3600 * 1000),
            // Most recent 429 per provider — limit 50 is plenty (5 providers,
            // each typically has 0-1 recent 429s; rare outage might have a
            // few). Ordered ts DESC so the FIRST row per provider is the
            // newest; we pick the first occurrence below.
            (0, providerErrorLog_1.queryProviderErrors)(app.pool, { errorCode: "429", limit: 50 }),
            // Retention window for the per-IP probe audit trail (0 = keep
            // forever). Read here so the ingest page can show the current
            // value in the scheduler form.
            (0, randomProbeLog_1.loadRetentionDays)(app.pool),
        ]);
        const { readRandomGenState } = await Promise.resolve().then(() => __importStar(require("../../web/plugins/randomIpGeneratorRunner")));
        const randomGenState = await readRandomGenState(app.pool);
        // Consume short-lived flash cookies set by POST handlers. Both
        // backfill and random-gen POST routes set JSON cookies on the
        // redirect; we decode them once here and clear them so the banner
        // doesn't reappear on subsequent refreshes. Invalid JSON is
        // treated as no flash (cookie set by older builds before schema
        // changes, or tampered).
        const flash = {};
        const backfillCookie = req.cookies["backfill_summary"];
        if (backfillCookie) {
            try {
                flash.backfillSummary = JSON.parse(backfillCookie);
            }
            catch {
                /* ignore */
            }
            reply.clearCookie("backfill_summary", { path: "/admin/ingest" });
        }
        const generateCookie = req.cookies["generate_summary"];
        if (generateCookie) {
            try {
                flash.generateSummary = JSON.parse(generateCookie);
            }
            catch {
                /* ignore */
            }
            reply.clearCookie("generate_summary", { path: "/admin/ingest" });
        }
        const queueFlashCookie = req.cookies["queue_flash"];
        if (queueFlashCookie) {
            try {
                flash.queueFlash = JSON.parse(queueFlashCookie);
            }
            catch {
                /* ignore */
            }
            reply.clearCookie("queue_flash", { path: "/admin/ingest" });
        }
        // Per-provider health summary. Sort order: failing → disabled →
        // recovering → healthy → idle (operator sees bad providers first).
        // Status computation uses lastErrorAt/lastUsedAt freshness and the
        // disabled flag; counts come from the last persisted backfill run.
        //
        // Each provider is enriched with three windowed health aggregates
        // (1h / 24h / 7d), a today's-quota percentage + pill kind, an
        // auto-re-enable countdown (only meaningful when disabled AND
        // autoReenableAt is set), and the most-recent 429 detail row.
        // Pre-resolve the quota kind string + the formatted reenable copy
        // here so the template doesn't need to evaluate ternary nesting
        // (Handlebars has no `gt` helper).
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;
        // Index the window aggregates by provider name for the .map() below.
        const h1hByName = new Map(health1hAll.map((w) => [w.providerName, w]));
        const h24hByName = new Map(health24hAll.map((w) => [w.providerName, w]));
        const h7dByName = new Map(health7dAll.map((w) => [w.providerName, w]));
        // last429Rows is ordered ts DESC — the FIRST occurrence of each
        // providerName wins. Use Map to enforce that order.
        const last429ByName = new Map();
        for (const row of last429Rows) {
            if (!last429ByName.has(row.providerName))
                last429ByName.set(row.providerName, row);
        }
        const providerHealth = providers
            .map((p) => {
            const lastStats = lastBackfill.providers[p.name];
            const lastErrFresh = p.lastErrorAt && now - p.lastErrorAt.getTime() < ONE_HOUR;
            const lastUseFresh = p.lastUsedAt && now - p.lastUsedAt.getTime() < ONE_HOUR;
            let status;
            if (!p.enabled)
                status = "disabled";
            else if (lastErrFresh && !lastUseFresh)
                status = "failing";
            else if (p.lastErrorAt && p.lastUsedAt && p.lastUsedAt > p.lastErrorAt)
                status = "healthy";
            else if (p.lastErrorAt)
                status = "recovering";
            else if (p.lastUsedAt)
                status = lastUseFresh ? "healthy" : "idle";
            else
                status = "idle";
            const health1h = h1hByName.get(p.name);
            const health24h = h24hByName.get(p.name);
            const health7d = h7dByName.get(p.name);
            // Today's quota = 24h call count / (per-minute quota * 60 * 24),
            // capped at 100% so over-quota providers don't render "1500%".
            // Providers with no parseable per-minute quota (e.g. "no key"
            // entries) fall back to 0%.
            const perMin = parseFreeQuotaPerMinute(p.name);
            const dailyCap = perMin > 0 ? perMin * 60 * 24 : 0;
            const calls24h = health24h?.calls ?? 0;
            const quotaTodayPct = dailyCap > 0 ? Math.min(100, Math.round((calls24h / dailyCap) * 100)) : 0;
            const quotaKind = dailyCap === 0
                ? "muted"
                : quotaTodayPct > 100
                    ? "danger" // unreachable due to Math.min, kept for explicitness
                    : quotaTodayPct > 80
                        ? "warning"
                        : "success";
            // Pre-resolve the localized "auto-re-enables in Nm" string so the
            // template can render it via {{text}} on a pill without using
            // {{req.t key minutes=...}} (which Handlebars drops).
            const reenableMsLeft = p.autoReenableAt ? Date.parse(p.autoReenableAt.toString()) - now : 0;
            const reenableMinutesLeft = p.autoReenableAt ? Math.max(1, Math.ceil(reenableMsLeft / 60000)) : 0;
            const reenableText = p.autoReenableAt
                ? req.t("admin.unknownIps.healthCard.reenablesIn", { minutes: reenableMinutesLeft })
                : "";
            const reenableKind = p.autoReenableAt ? "warning" : "muted";
            return {
                name: p.name,
                displayName: p.displayName,
                freeQuota: p.freeQuota,
                enabled: p.enabled,
                hasApiKey: Boolean(p.apiKey),
                status,
                lastUsedAt: p.lastUsedAt,
                lastErrorAt: p.lastErrorAt,
                lastErrorReason: p.lastErrorReason,
                lastStats: lastStats ?? null,
                // Windowed health aggregates — always present (one row per
                // catalog provider, even with zero calls). failurePct is the
                // human-friendly rounded percentage the template renders.
                // Fall back to zero rows for any provider name not in the
                // aggregate output (defensive — shouldn't happen since the
                // catalog is the single source of truth).
                health1h: {
                    calls: health1h?.calls ?? 0,
                    errors429: health1h?.errors429 ?? 0,
                    failurePct: health1h?.failureRatePct ?? 0,
                },
                health24h: {
                    calls: health24h?.calls ?? 0,
                    errors429: health24h?.errors429 ?? 0,
                    failurePct: health24h?.failureRatePct ?? 0,
                },
                health7d: {
                    calls: health7d?.calls ?? 0,
                    errors429: health7d?.errors429 ?? 0,
                    failurePct: health7d?.failureRatePct ?? 0,
                },
                // Today's quota pill.
                quotaTodayPct,
                quotaKind,
                quotaTodayText: req.t("admin.unknownIps.healthCard.quotaToday", { pct: quotaTodayPct }),
                // Auto-re-enable countdown pill — only meaningful when
                // enabled=false && autoReenableAt. Template guards the
                // rendering; we still ship the pre-resolved text + kind so
                // the template doesn't need hash-arg i18n.
                autoReenableAt: p.autoReenableAt,
                autoDisabledReason: p.autoDisabledReason,
                reenableText,
                reenableKind,
                // Last 429 detail — full ProviderErrorRow (rawResponse +
                // ipText + ts) so the template can render the `<details>`
                // block. Null when no 429 has been recorded yet.
                lastError: last429ByName.get(p.name) ?? null,
            };
        })
            .sort((a, b) => {
            const order = { failing: 0, disabled: 1, recovering: 2, healthy: 3, idle: 4 };
            const diff = order[a.status] - order[b.status];
            if (diff !== 0)
                return diff;
            return a.name.localeCompare(b.name);
        });
        return reply.view("admin/unknown-ips.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.unknownIps.title"),
            pending: data.pending,
            recentlyProcessed: data.recentlyProcessed,
            stats,
            providers,
            providerHealth,
            lastBackfillRunAt: lastBackfill.runAt,
            flash,
            randomGenState,
            randomGenConfig,
            retentionDays,
            recentProbes: recentProbeRows,
            probeSummaryStats: probeSummary,
            errors,
            errorCodes,
            errorFilters: {
                provider: q.provider ?? "",
                errorCode: q.errorCode ?? "",
                mode: q.mode ?? "",
                since: q.since ?? "",
            },
            circuitBreaker,
            activeTab: tab,
            limit,
            csrfToken: req.csrfToken,
            req,
        });
    });
    // Toggle provider on/off and rotate api_key from the admin UI. POST
    // accepts `name`, optional `enabled` ("on"/"off"), optional `apiKey`.
    // Only enabled / api_key are editable from here; the catalog (display
    // name + free quota) is code-managed.
    //
    // reapProviders() runs FIRST so the admin's manual toggle wins over a
    // concurrent reaper tick that might be about to re-enable the same
    // provider (or auto-disable another). The reaper's WHERE-clause
    // filters on auto_reenable_at <= NOW() so this is a no-op for
    // providers whose cooldown hasn't elapsed yet — the cost is one
    // indexed SELECT.
    app.post("/admin/providers/:name", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const name = req.params.name;
        const body = req.body;
        const { reapProviders } = await Promise.resolve().then(() => __importStar(require("../../web/plugins/randomIpGeneratorRunner")));
        await reapProviders(app.pool);
        req.auditAction = {
            action: "unknown_ips.provider.update",
            targetType: "ingest_provider",
            targetId: name,
            metadata: { enabled: body.enabled, hasKey: Boolean(body.apiKey && body.apiKey.length > 0) },
        };
        await (0, ingestProviders_1.updateProviderConfig)(app.pool, name, {
            enabled: body.enabled === "on",
            apiKey: body.apiKey === undefined ? undefined : body.apiKey.trim() === "" ? null : body.apiKey.trim(),
        });
        return reply.redirect("/admin/providers");
    });
    // Bulk queue ops. Both CSRF-gated. The clear action wipes pending
    // rows (preserving processed rows as the audit trail). Export streams
    // the CSV inline with content-disposition so the browser saves a file.
    app.post("/admin/ingest/queue/clear", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "unknown_ips.queue.clear", targetType: "unknown_ip_queue" };
        const removed = await (0, unknownIpQueue_2.clearPending)(app.pool);
        reply.setCookie("queue_flash", JSON.stringify({ kind: "cleared", removed }), {
            path: "/admin/ingest",
            maxAge: 30,
            httpOnly: true,
            sameSite: "lax",
        });
        return reply.redirect("/admin/ingest#overview");
    });
    app.get("/admin/ingest/queue/export", async (req, reply) => {
        // GET so the admin can right-click → "save link as" without JS.
        // CSRF not required: this is a read-only data export, not a state
        // change. The whole /admin/* tree already gates on session+admin.
        const csv = await (0, unknownIpQueue_2.exportPendingCsv)(app.pool);
        const filename = `unknown-ip-queue-${new Date().toISOString().slice(0, 10)}.csv`;
        reply.header("content-type", "text/csv; charset=utf-8");
        reply.header("content-disposition", `attachment; filename="${filename}"`);
        return csv;
    });
    // Circuit-breaker config save. Persists to settings (cb_*) and
    // refreshes the in-memory cache used by the next backfill run.
    app.post("/admin/providers/circuit-breaker", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const body = req.body;
        req.auditAction = {
            action: "unknown_ips.circuit_breaker.update",
            targetType: "settings",
            metadata: {
                enabled: body.enabled === "on",
                threshold: Number(body.threshold) || 50,
                window: Number(body.window) || 10,
                cooldown: Number(body.cooldown) || 15,
            },
        };
        await (0, providerErrorLog_1.setCircuitBreakerConfig)(app.pool, {
            enabled: body.enabled === "on",
            failureThresholdPct: Number(body.threshold),
            windowMinutes: Number(body.window),
            cooldownMinutes: Number(body.cooldown),
        });
        return reply.redirect("/admin/providers");
    });
    // Re-queue a single IP from the Failure Logs tab. Insert-or-increment
    // (idempotent) so re-clicking doesn't double-count.
    app.post("/admin/ingest/failure-logs/requeue", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const body = req.body;
        const ipText = (body.ip ?? "").trim();
        if (!ipText)
            return reply.redirect("/admin/ingest#failure-logs");
        req.auditAction = {
            action: "unknown_ips.failure_logs.requeue",
            targetType: "unknown_ip_queue",
            targetId: ipText,
        };
        const { insertOrIncrement } = await Promise.resolve().then(() => __importStar(require("../../storage/unknownIpQueue")));
        const { parseIp } = await Promise.resolve().then(() => __importStar(require("../../ip")));
        const parsed = parseIp(ipText);
        if (!parsed) {
            reply.setCookie("queue_flash", JSON.stringify({ kind: "invalidIp", ip: ipText }), {
                path: "/admin/ingest",
                maxAge: 30,
                httpOnly: true,
                sameSite: "lax",
            });
            return reply.redirect("/admin/ingest#failure-logs");
        }
        // parseIp returns a Buffer; insertOrIncrement expects one too. The
        // static types collide because parseIp's return is structurally
        // ArrayBufferLike in this TS version; cast at the boundary.
        await insertOrIncrement(app.pool, Buffer.from(parsed.buffer), ipText, { source: "manual_submit" });
        return reply.redirect("/admin/ingest#failure-logs");
    });
    // GET — show the "Preview first / Run" form. Operator picks batchLimit,
    // hits Preview to get a preview page, or hits Confirm (legacy path
    // disabled — the new flow goes through /preview first).
    app.get("/admin/ingest/backfill/confirm", async (req, reply) => {
        return reply.view("admin/unknown-ips-backfill-confirm.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.unknownIps.backfill.confirm.title"),
            req,
        });
    });
    // POST /admin/ingest/backfill/preview — dry-run the fan-out, store the
    // would-be rows in a signed cookie (60s TTL), redirect to the preview
    // page. The confirm handler reads this cookie + the matching form token
    // before doing any writes.
    app.post("/admin/ingest/backfill/preview", {
        // Each preview fans out to every provider for up to `batchLimit`
        // IPs. Rate-limit the route so a repeated click (or a stuck
        // client retrying) can't burn the providers' free-tier quota.
        config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    }, async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "unknown_ips.backfill.preview", targetType: "unknown_ip_queue" };
        const batchLimit = Math.min(Math.max(Number(req.body.batchLimit ?? 100) || 100, 1), 1000);
        const configs = await (0, ingestProviders_1.listProviderConfigs)(app.pool);
        const providers = (0, ingestProviders_1.buildProvidersFromConfig)(configs);
        const result = await (0, unknownIpBackfill_1.runBackfill)(app.pool, providers, {
            batchLimit,
            mode: "auto",
            dryRun: true,
            logger: {
                log: () => { },
                warn: (msg) => app.log.warn({ msg }, "backfill-preview"),
                error: (msg) => app.log.error({ msg }, "backfill-preview"),
            },
        });
        // Another ingest path held the provider mutex — this run made no
        // provider calls. Bounce to /admin/ingest with a notice rather
        // than rendering an empty preview table.
        if (result.skippedLockBusy) {
            reply.clearCookie(BACKFILL_PREVIEW_COOKIE, { path: BACKFILL_PREVIEW_COOKIE_PATH });
            reply.setCookie("backfill_summary", JSON.stringify({ kind: "preview_lock_busy" }), {
                path: "/admin/ingest",
                maxAge: 30,
                httpOnly: false,
                sameSite: "lax",
                signed: false,
            });
            return reply.redirect("/admin/ingest", 302);
        }
        const token = (0, node_crypto_1.randomBytes)(16).toString("hex");
        const cookie = signBackfillPreview({
            runAt: Date.now(),
            rows: result.previewRows,
            batchLimit,
            token,
        });
        reply.setCookie(BACKFILL_PREVIEW_COOKIE, cookie, {
            path: BACKFILL_PREVIEW_COOKIE_PATH,
            httpOnly: true,
            sameSite: "lax",
            maxAge: Math.floor(BACKFILL_PREVIEW_MAX_AGE_MS / 1000),
            // We sign ourselves (HMAC-SHA256 above); Fastify's built-in signed
            // cookie helper would re-encode our JSON and break verification.
            signed: false,
        });
        return reply.redirect("/admin/ingest/backfill/preview", 302);
    });
    // GET /admin/ingest/backfill/preview — render the preview table. If the
    // cookie is missing/expired/tampered, flash a message and bounce to
    // /admin/ingest (no surface to render).
    app.get("/admin/ingest/backfill/preview", async (req, reply) => {
        const cookie = req.cookies[BACKFILL_PREVIEW_COOKIE];
        const v = cookie ? verifyBackfillPreview(cookie) : { ok: false, reason: "missing" };
        if (!v.ok) {
            reply.clearCookie(BACKFILL_PREVIEW_COOKIE, { path: BACKFILL_PREVIEW_COOKIE_PATH });
            const flashKey = v.reason === "expired" ? "expired" : "missing";
            reply.setCookie("backfill_summary", JSON.stringify({ kind: "preview_" + flashKey }), {
                path: "/admin/ingest",
                maxAge: 30,
                httpOnly: false,
                sameSite: "lax",
                signed: false,
            });
            return reply.redirect("/admin/ingest", 302);
        }
        return reply.view("admin/ingest-backfill-preview.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.ingest.backfill.preview.title"),
            rows: v.payload.rows,
            batchLimit: v.payload.batchLimit,
            token: v.payload.token,
            runAt: v.payload.runAt,
            csrfToken: req.csrfToken,
            req,
        });
    });
    // POST /admin/ingest/backfill/confirm — verify cookie + token, then
    // re-run the fan-out for real (no dryRun). On success clear the cookie
    // and flash a backfill_summary so /admin/ingest shows the run stats.
    app.post("/admin/ingest/backfill/confirm", {
        // This route performs the REAL provider fan-out and writes to
        // ip_ranges. Rate-limit it hard — 5/hour is generous for an
        // interactive admin action and protects the free-tier quota.
        config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
    }, async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "unknown_ips.backfill", targetType: "unknown_ip_queue" };
        const cookie = req.cookies[BACKFILL_PREVIEW_COOKIE];
        const v = cookie ? verifyBackfillPreview(cookie) : { ok: false, reason: "missing" };
        const body = req.body;
        if (!v.ok) {
            reply.clearCookie(BACKFILL_PREVIEW_COOKIE, { path: BACKFILL_PREVIEW_COOKIE_PATH });
            reply.setCookie("backfill_summary", JSON.stringify({ kind: "preview_" + v.reason }), {
                path: "/admin/ingest",
                maxAge: 30,
                httpOnly: false,
                sameSite: "lax",
                signed: false,
            });
            return reply.redirect("/admin/ingest", 302);
        }
        if (!body.token || body.token !== v.payload.token) {
            // Token mismatch: replay/tamper. Clear cookie + redirect (no
            // detailed error to avoid leaking probe details).
            reply.clearCookie(BACKFILL_PREVIEW_COOKIE, { path: BACKFILL_PREVIEW_COOKIE_PATH });
            return reply.redirect("/admin/ingest", 302);
        }
        const batchLimit = v.payload.batchLimit;
        const configs = await (0, ingestProviders_1.listProviderConfigs)(app.pool);
        const providers = (0, ingestProviders_1.buildProvidersFromConfig)(configs);
        const summary = await (0, unknownIpBackfill_1.runBackfill)(app.pool, providers, {
            batchLimit,
            mode: "auto",
            // dryRun defaults to false — this is the real write path.
            logger: {
                log: () => { },
                warn: (msg) => app.log.warn({ msg }, "backfill"),
                error: (msg) => app.log.error({ msg }, "backfill"),
            },
        });
        // Another ingest path held the provider mutex — this run made no
        // provider calls and wrote nothing. Report it instead of showing
        // an all-zero "success" summary.
        if (summary.skippedLockBusy) {
            reply.clearCookie(BACKFILL_PREVIEW_COOKIE, { path: BACKFILL_PREVIEW_COOKIE_PATH });
            reply.setCookie("backfill_summary", JSON.stringify({ kind: "lock_busy" }), {
                path: "/admin/ingest",
                maxAge: 30,
                httpOnly: false,
                sameSite: "lax",
                signed: false,
            });
            return reply.redirect("/admin/ingest", 302);
        }
        // Persist per-provider counts so the ingest dashboard can show
        // last-run stats across page refreshes (the flash cookie is gone
        // after one render). Same shape as BackfillSummary.providers.
        await (0, ingestProviders_1.saveLastBackfillProviderStats)(app.pool, summary.providers, new Date());
        // Clear the preview cookie once we've committed — a refresh of the
        // preview page should land on /admin/ingest, not re-render stale rows.
        reply.clearCookie(BACKFILL_PREVIEW_COOKIE, { path: BACKFILL_PREVIEW_COOKIE_PATH });
        // Redirect back with summary in flash cookie. Cookie is HTTP-only and
        // max-age=30s — admin refreshes the page and sees the banner once.
        reply.setCookie("backfill_summary", JSON.stringify(summary), {
            path: "/admin/ingest",
            maxAge: 30,
            httpOnly: true,
            sameSite: "lax",
        });
        return reply.redirect("/admin/ingest#overview", 302);
    });
    // "Generate 10 random IPs and ingest them". Used to validate the
    // ingest pipeline end-to-end without waiting for real /lookup misses
    // to trickle in. Auto-disables providers that return HTTP 429 during
    // the run so we don't keep hammering a throttled provider. Target:
    // 10 IPs in 10 minutes (per-IP fan-out ~8s serial = ~80s for 10).
    app.post("/admin/ingest/generate", {
        // Manual generate fans out to every provider for up to 50 IPs.
        // Same reasoning as the backfill routes — protect the quota.
        config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    }, async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "unknown_ips.generate", targetType: "unknown_ip_queue" };
        const body = req.body;
        const count = Math.min(Math.max(Number(body.count) || 10, 1), 50);
        const configs = await (0, ingestProviders_1.listProviderConfigs)(app.pool);
        const providers = (0, ingestProviders_1.buildProvidersFromConfig)(configs);
        const summary = await (0, randomIpGenerator_1.runRandomGeneration)(app.pool, providers, {
            count,
            logger: {
                log: () => { },
                warn: (msg) => app.log.warn({ msg }, "random-gen"),
                error: (msg) => app.log.error({ msg }, "random-gen"),
            },
        });
        // Another ingest path held the provider mutex — no provider calls
        // were made. Report the skip instead of an all-zero "success".
        if (summary.skippedLockBusy) {
            reply.setCookie("generate_summary", JSON.stringify({ kind: "lock_busy" }), {
                path: "/admin/ingest",
                maxAge: 60,
                httpOnly: false,
                sameSite: "lax",
            });
            return reply.redirect("/admin/ingest#overview");
        }
        // Note: runRandomGeneration currently records probes with mode='random'.
        // Distinguishing continuous vs one-shot would require threading a mode
        // parameter through runRandomGeneration; deferred to a follow-up.
        // Random-gen also produces per-provider counts — persist so the
        // dashboard reflects this run even after the flash cookie expires.
        await (0, ingestProviders_1.saveLastBackfillProviderStats)(app.pool, summary.providers, new Date());
        reply.setCookie("generate_summary", JSON.stringify(summary), {
            path: "/admin/ingest",
            maxAge: 60,
            httpOnly: true,
            sameSite: "lax",
        });
        return reply.redirect("/admin/ingest#overview");
    });
    // Continuous runner toggle + manual kick. The runner is a separate
    // setInterval-based plugin (see registerRandomGenRunner) that fires
    // every 60s when the persisted `random_gen_enabled` setting is '1'.
    // POST accepts `enabled=on|off` to flip the setting (and start/stop
    // the timer immediately) and `kick=1` to run an out-of-band tick.
    app.post("/admin/ingest/generate/continuous", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "unknown_ips.generate.continuous", targetType: "settings" };
        const body = req.body;
        const { setSetting } = await Promise.resolve().then(() => __importStar(require("../../storage/settings")));
        if (body.kick === "1") {
            // Manual kick — fire-and-forget but wait briefly so the next
            // GET sees the updated lastSummary. tickNow already logs and
            // persists on its own; we just await so the redirect lands
            // after the write.
            await app.randomGenRunner.tickNow();
        }
        else if (body.enabled === "on" || body.enabled === "off") {
            await setSetting(app.pool, "random_gen_enabled", body.enabled === "on" ? "1" : "0");
            await app.randomGenRunner.syncFromSettings();
        }
        return reply.redirect("/admin/ingest#overview");
    });
    // Scheduler config (interval / batch / cooldown / CB linkage). The
    // values are persisted to the `random_gen_*` settings; saveRandomGenConfig
    // clamps each one to a safe range. If `intervalSec` changed, the runner
    // needs to restart its setInterval — syncFromSettings handles that.
    app.post("/admin/ingest/scheduler", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const body = req.body;
        const intervalSec = Number(body.intervalSec);
        const batchSize = Number(body.batchSize);
        const cooldownMinutes = Number(body.cooldownMinutes);
        const cbLinkage = body.cbLinkage === "on";
        const retentionDays = Number(body.retentionDays);
        req.auditAction = {
            action: "unknown_ips.scheduler.update",
            targetType: "settings",
            metadata: {
                intervalSec,
                batchSize,
                cooldownMinutes,
                cbLinkage,
                // NaN when the field was absent — record null rather than a
                // NaN that would render as "NaN" in the audit log.
                retentionDays: Number.isFinite(retentionDays) ? retentionDays : null,
            },
        };
        await (0, randomProbeLog_1.saveRandomGenConfig)(app.pool, {
            intervalSec: Number.isFinite(intervalSec) ? intervalSec : undefined,
            batchSize: Number.isFinite(batchSize) ? batchSize : undefined,
            cooldownMinutes: Number.isFinite(cooldownMinutes) ? cooldownMinutes : undefined,
            cbLinkage,
        });
        // Retention window for the per-IP probe audit trail. Only written
        // when the field is present and parses as a number — an absent
        // field leaves the stored value untouched (so a form that predates
        // this input can't silently reset it to 0 = keep forever).
        if (body.retentionDays !== undefined && Number.isFinite(retentionDays)) {
            await (0, randomProbeLog_1.saveRetentionDays)(app.pool, retentionDays);
        }
        await app.randomGenRunner.syncFromSettings();
        return reply.redirect("/admin/ingest#overview");
    });
    const enrichBuiltInHealth = async (req) => {
        const [configs, lastBackfill, health1hAll, health24hAll, health7dAll, last429Rows] = await Promise.all([
            (0, ingestProviders_1.listProviderConfigs)(app.pool),
            (0, ingestProviders_1.loadLastBackfillProviderStats)(app.pool),
            (0, providerErrorLog_1.getAggregateProviderHealthAllCached)(app.pool, 1 * 3600 * 1000),
            (0, providerErrorLog_1.getAggregateProviderHealthAllCached)(app.pool, 24 * 3600 * 1000),
            (0, providerErrorLog_1.getAggregateProviderHealthAllCached)(app.pool, 7 * 24 * 3600 * 1000),
            (0, providerErrorLog_1.queryProviderErrors)(app.pool, { errorCode: "429", limit: 50 }),
        ]);
        // Catalog providers only — custom providers live in their own list.
        const builtins = configs.filter((c) => !c.isCustom);
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;
        const h1hByName = new Map(health1hAll.map((w) => [w.providerName, w]));
        const h24hByName = new Map(health24hAll.map((w) => [w.providerName, w]));
        const h7dByName = new Map(health7dAll.map((w) => [w.providerName, w]));
        const last429ByName = new Map();
        for (const row of last429Rows) {
            if (!last429ByName.has(row.providerName))
                last429ByName.set(row.providerName, row);
        }
        const enriched = builtins.map((p) => {
            const lastStats = lastBackfill.providers[p.name];
            const lastErrFresh = p.lastErrorAt && now - p.lastErrorAt.getTime() < ONE_HOUR;
            const lastUseFresh = p.lastUsedAt && now - p.lastUsedAt.getTime() < ONE_HOUR;
            let status;
            if (!p.enabled)
                status = "disabled";
            else if (lastErrFresh && !lastUseFresh)
                status = "failing";
            else if (p.lastErrorAt && p.lastUsedAt && p.lastUsedAt > p.lastErrorAt)
                status = "healthy";
            else if (p.lastErrorAt)
                status = "recovering";
            else if (p.lastUsedAt)
                status = lastUseFresh ? "healthy" : "idle";
            else
                status = "idle";
            const health1h = h1hByName.get(p.name);
            const health24h = h24hByName.get(p.name);
            const health7d = h7dByName.get(p.name);
            const perMin = parseFreeQuotaPerMinute(p.name);
            const dailyCap = perMin > 0 ? perMin * 60 * 24 : 0;
            const calls24h = health24h?.calls ?? 0;
            const quotaTodayPct = dailyCap > 0 ? Math.min(100, Math.round((calls24h / dailyCap) * 100)) : 0;
            const quotaKind = dailyCap === 0
                ? "muted"
                : quotaTodayPct > 100
                    ? "danger"
                    : quotaTodayPct > 80
                        ? "warning"
                        : "success";
            const reenableMsLeft = p.autoReenableAt ? Date.parse(p.autoReenableAt.toString()) - now : 0;
            const reenableMinutesLeft = p.autoReenableAt ? Math.max(1, Math.ceil(reenableMsLeft / 60000)) : 0;
            const reenableText = p.autoReenableAt
                ? req.t("admin.unknownIps.healthCard.reenablesIn", { minutes: reenableMinutesLeft })
                : "";
            const reenableKind = p.autoReenableAt ? "warning" : "muted";
            return {
                name: p.name,
                displayName: p.displayName,
                freeQuota: p.freeQuota,
                enabled: p.enabled,
                hasApiKey: Boolean(p.apiKey),
                status,
                lastUsedAt: p.lastUsedAt,
                lastErrorAt: p.lastErrorAt,
                lastErrorReason: p.lastErrorReason,
                lastStats: lastStats ?? null,
                health1h: {
                    calls: health1h?.calls ?? 0,
                    errors429: health1h?.errors429 ?? 0,
                    failurePct: health1h?.failureRatePct ?? 0,
                },
                health24h: {
                    calls: health24h?.calls ?? 0,
                    errors429: health24h?.errors429 ?? 0,
                    failurePct: health24h?.failureRatePct ?? 0,
                },
                health7d: {
                    calls: health7d?.calls ?? 0,
                    errors429: health7d?.errors429 ?? 0,
                    failurePct: health7d?.failureRatePct ?? 0,
                },
                quotaTodayPct,
                quotaKind,
                quotaTodayText: req.t("admin.unknownIps.healthCard.quotaToday", { pct: quotaTodayPct }),
                autoReenableAt: p.autoReenableAt,
                autoDisabledReason: p.autoDisabledReason,
                reenableText,
                reenableKind,
                lastError: last429ByName.get(p.name) ?? null,
            };
        });
        // Sort order matches the /admin/unknown-ips tab: failing → disabled →
        // recovering → healthy → idle, alpha within tier.
        return enriched.sort((a, b) => {
            const order = { failing: 0, disabled: 1, recovering: 2, healthy: 3, idle: 4 };
            const diff = order[a.status] - order[b.status];
            if (diff !== 0)
                return diff;
            return a.name.localeCompare(b.name);
        });
    };
    const enrichCustomProviders = async () => {
        const configs = await (0, ingestProviders_1.listProviderConfigs)(app.pool);
        const customConfigs = configs.filter((c) => c.isCustom);
        const { aggregateProviderHealth } = await Promise.resolve().then(() => __importStar(require("../../storage/providerErrorLog")));
        return Promise.all(customConfigs.map(async (c) => {
            const [h1h, h24h, h7d] = await Promise.all([
                aggregateProviderHealth(app.pool, c.name, 1 * 3600 * 1000),
                aggregateProviderHealth(app.pool, c.name, 24 * 3600 * 1000),
                aggregateProviderHealth(app.pool, c.name, 7 * 24 * 3600 * 1000),
            ]);
            return {
                name: c.name,
                displayName: c.displayName,
                enabled: c.enabled,
                urlTemplate: c.customUrlTemplate ?? "",
                method: c.customMethod,
                requestBody: c.customRequestBody ?? "",
                responseFormat: c.customResponseFormat,
                countryPath: c.customCountryPath ?? "",
                cityPath: c.customCityPath ?? "",
                asnPath: c.customAsnPath ?? "",
                timeoutMs: c.customTimeoutMs ?? 5000,
                health1h: { calls: h1h.calls, errors429: h1h.errors429, failurePct: h1h.failureRatePct },
                health24h: { calls: h24h.calls, errors429: h24h.errors429, failurePct: h24h.failureRatePct },
                health7d: { calls: h7d.calls, errors429: h7d.errors429, failurePct: h7d.failureRatePct },
                lastErrorAt: c.lastErrorAt,
                lastErrorReason: c.lastErrorReason,
            };
        }));
    };
    // /admin/providers — consolidated Strategy Definition surface. Renders
    // built-in health cards + circuit-breaker form + custom-provider CRUD
    // on one URL. Pulled out of /admin/unknown-ips as part of the
    // strategy-pattern UI refactor.
    app.get("/admin/providers", async (req, reply) => {
        const [providerHealth, customProviders, circuitBreaker] = await Promise.all([
            enrichBuiltInHealth(req),
            enrichCustomProviders(),
            (0, providerErrorLog_1.getCircuitBreakerConfig)(app.pool),
        ]);
        let flash = {};
        // Consume the same flash cookie the existing custom-providers POST
        // handlers set. The cookie path differs between the old and new
        // endpoints, so we read both — the union will pick whichever path
        // was used last.
        const oldCookie = req.cookies["custom_providers_flash"];
        if (oldCookie) {
            try {
                flash = JSON.parse(oldCookie);
            }
            catch {
                /* ignore */
            }
            reply.clearCookie("custom_providers_flash", { path: "/admin/unknown-ips/providers/custom" });
        }
        return reply.view("admin/providers.hbs", {
            layout: "layouts/admin",
            title: req.t("admin.providers.title"),
            providerHealth,
            customProviders,
            circuitBreaker,
            flash,
            csrfToken: req.csrfToken,
            req,
        });
    });
    app.post("/admin/providers/custom", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const body = req.body;
        const name = String(body.name ?? "")
            .trim()
            .toLowerCase();
        const errors = [];
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
            errors.push("invalidUrl"); // reuse generic error key — name format catches here
        }
        const urlTemplate = String(body.urlTemplate ?? "").trim();
        if (!urlTemplate)
            errors.push("invalidUrl");
        // SSRF check at form-time so we reject before saving.
        if (urlTemplate && !(await (0, ssrf_1.assertSafeHttpUrl)(urlTemplate)).ok) {
            errors.push("invalidUrl");
        }
        const method = body.method === "POST" ? "POST" : "GET";
        const responseFormat = body.responseFormat === "text" ? "text" : "json";
        const countryPath = String(body.countryPath ?? "").trim();
        if (!countryPath)
            errors.push("invalidFieldPath");
        // Built-in names are not allowed — even though is_custom=1 would let
        // us override, the admin UI lists built-ins separately and avoiding
        // the collision is far less confusing than allowing shadow-override.
        if (name in ingestProviders_1.PROVIDER_CATALOG) {
            errors.push("nameConflict");
        }
        if (errors.length > 0) {
            req.auditAction = {
                action: "unknown_ips.custom_providers.create.error",
                targetType: "ingest_provider",
                targetId: name,
                metadata: { errors },
            };
            // Render the providers page with an inline error banner — the old
            // custom-providers page used to be its own URL, but with the
            // consolidated /admin/providers surface we render the same view
            // with the flash message so the admin sees context for the error.
            const [providerHealth, customProviders, circuitBreaker] = await Promise.all([
                enrichBuiltInHealth(req),
                enrichCustomProviders(),
                (0, providerErrorLog_1.getCircuitBreakerConfig)(app.pool),
            ]);
            const flash = { kind: "error", message: req.t(`admin.unknownIps.customProviders.errors.${errors[0]}`) };
            return reply.view("admin/providers.hbs", {
                layout: "layouts/admin",
                title: req.t("admin.providers.title"),
                providerHealth,
                customProviders,
                circuitBreaker,
                flash,
                csrfToken: req.csrfToken,
                req,
            });
        }
        req.auditAction = {
            action: "unknown_ips.custom_providers.create",
            targetType: "ingest_provider",
            targetId: name,
        };
        await (0, ingestProviders_1.upsertCustomProvider)(app.pool, name, {
            displayName: String(body.displayName ?? name).trim() || name,
            urlTemplate,
            method,
            requestBody: body.requestBody ? String(body.requestBody) : null,
            responseFormat,
            countryPath,
            cityPath: body.cityPath ? String(body.cityPath).trim() : null,
            asnPath: body.asnPath ? String(body.asnPath).trim() : null,
            timeoutMs: body.timeoutMs ? Number(body.timeoutMs) || 5000 : null,
            apiKey: body.apiKey ? String(body.apiKey) : null,
            enabled: body.enabled === "on",
        });
        reply.setCookie("custom_providers_flash", JSON.stringify({ kind: "saved", name }), {
            path: "/admin/providers",
            maxAge: 30,
            httpOnly: true,
            sameSite: "lax",
        });
        return reply.redirect("/admin/providers");
    });
    app.post("/admin/providers/custom/:name/delete", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const name = req.params.name;
        req.auditAction = {
            action: "unknown_ips.custom_providers.delete",
            targetType: "ingest_provider",
            targetId: name,
        };
        const removed = await (0, ingestProviders_1.deleteCustomProvider)(app.pool, name);
        reply.setCookie("custom_providers_flash", JSON.stringify({ kind: "deleted", name, removed }), {
            path: "/admin/providers",
            maxAge: 30,
            httpOnly: true,
            sameSite: "lax",
        });
        return reply.redirect("/admin/providers");
    });
    app.post("/admin/providers/custom/:name/test", {
        // Each call hits the provider's real API. This is NOT part of the
        // provider fan-out mutex (it is a single, immediate, user-facing
        // probe of one provider — holding the mutex would block it behind
        // a long batch run), so it gets its own rate limit instead:
        // 20/hour is generous for config testing but still stops a stuck
        // client from burning the provider's free tier.
        config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    }, async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        const name = req.params.name;
        const body = req.body;
        const ipText = String(body.ip ?? "").trim();
        if (!ipText)
            return reply.code(400).send({ ok: false, error: "ip_required" });
        const cfg = await (0, ingestProviders_1.getProviderConfig)(app.pool, name);
        if (!cfg || !cfg.isCustom) {
            return reply.code(404).send({ ok: false, error: "not_found" });
        }
        req.auditAction = {
            action: "unknown_ips.custom_providers.test",
            targetType: "ingest_provider",
            targetId: name,
            metadata: { ip: ipText },
        };
        const provider = new genericHttpProvider_1.GenericHttpProvider({
            name: cfg.name,
            urlTemplate: cfg.customUrlTemplate ?? "",
            method: cfg.customMethod,
            requestBody: cfg.customRequestBody,
            responseFormat: cfg.customResponseFormat,
            countryPath: cfg.customCountryPath,
            cityPath: cfg.customCityPath,
            asnPath: cfg.customAsnPath,
            timeoutMs: cfg.customTimeoutMs,
            apiKey: cfg.apiKey,
        });
        try {
            const { parseIp } = await Promise.resolve().then(() => __importStar(require("../../ip")));
            const buf = parseIp(ipText);
            if (!buf)
                return reply.code(400).send({ ok: false, error: "invalid_ip" });
            const result = await provider.lookup(buf);
            if (result.record) {
                return reply.send({
                    ok: true,
                    record: {
                        countryCode: result.record.countryCode,
                        city: result.record.city,
                        asn: result.record.asn,
                    },
                });
            }
            return reply.send({
                ok: false,
                error: result.errorCode ?? "no_record",
                raw: result.rawResponse ?? null,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return reply.code(500).send({ ok: false, error: "lookup_threw", raw: msg });
        }
    });
    // ─── Back-compat redirects (PR2) ──────────────────────────────────────
    // The /admin/unknown-ips URL tree moved to /admin/ingest/* (Strategy
    // Execution surface) and /admin/providers/* (Strategy Definition
    // surface). External links / bookmarks / automation call sites
    // pointing at the old paths continue to work via 302 redirects.
    const redirectOld = (from, to, method = "GET") => app.route({
        method,
        url: from,
        handler: (_req, reply) => reply.redirect(to, 302),
    });
    // Strategy Execution surface (moved to /admin/ingest/*):
    redirectOld("/admin/unknown-ips", "/admin/ingest");
    redirectOld("/admin/unknown-ips/queue/export", "/admin/ingest/queue/export");
    redirectOld("/admin/unknown-ips/queue/clear", "/admin/ingest/queue/clear", "POST");
    redirectOld("/admin/unknown-ips/generate", "/admin/ingest/generate", "POST");
    redirectOld("/admin/unknown-ips/generate/continuous", "/admin/ingest/generate/continuous", "POST");
    redirectOld("/admin/unknown-ips/scheduler", "/admin/ingest/scheduler", "POST");
    redirectOld("/admin/unknown-ips/failure-logs/requeue", "/admin/ingest/failure-logs/requeue", "POST");
    redirectOld("/admin/unknown-ips/backfill/confirm", "/admin/ingest/backfill/confirm");
    // Strategy Definition surface (moved to /admin/providers/*):
    redirectOld("/admin/unknown-ips/providers/custom", "/admin/providers#custom");
    redirectOld("/admin/unknown-ips/providers/custom/:name/delete", "/admin/providers/custom/:name/delete", "POST");
    redirectOld("/admin/unknown-ips/providers/custom/:name/test", "/admin/providers/custom/:name/test", "POST");
    redirectOld("/admin/unknown-ips/providers/:name", "/admin/providers/:name", "POST");
    redirectOld("/admin/unknown-ips/circuit-breaker", "/admin/providers/circuit-breaker", "POST");
    // Legacy one-step backfill path. The admin UI is preview-first (PR3),
    // but we keep this handler as a back-compat one-step run for any cron
    // / external caller still POSTing to the old URL. The new flow lives at
    // /admin/ingest/backfill/preview → /confirm.
    app.post("/admin/unknown-ips/backfill", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req))
            return (0, render_1.sendCsrfPage)(reply, 403);
        req.auditAction = { action: "unknown_ips.backfill", targetType: "unknown_ip_queue" };
        const batchLimit = Math.min(Math.max(Number(req.body.batchLimit ?? 100) || 100, 1), 1000);
        const configs = await (0, ingestProviders_1.listProviderConfigs)(app.pool);
        const providers = (0, ingestProviders_1.buildProvidersFromConfig)(configs);
        const summary = await (0, unknownIpBackfill_1.runBackfill)(app.pool, providers, {
            batchLimit,
            mode: "auto",
            logger: {
                log: () => { },
                warn: (msg) => app.log.warn({ msg }, "backfill-legacy"),
                error: (msg) => app.log.error({ msg }, "backfill-legacy"),
            },
        });
        await (0, ingestProviders_1.saveLastBackfillProviderStats)(app.pool, summary.providers, new Date());
        reply.setCookie("backfill_summary", JSON.stringify(summary), {
            path: "/admin/ingest",
            maxAge: 30,
            httpOnly: true,
            sameSite: "lax",
        });
        return reply.redirect("/admin/ingest#overview", 302);
    });
}
//# sourceMappingURL=admin.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clampInt = clampInt;
exports.mcpLookup = mcpLookup;
exports.lookupToolDef = lookupToolDef;
exports.mcpQueueStats = mcpQueueStats;
exports.queueStatsToolDef = queueStatsToolDef;
exports.mcpEtlStatus = mcpEtlStatus;
exports.etlStatusToolDef = etlStatusToolDef;
exports.queueTopToolDef = queueTopToolDef;
exports.mcpQueueTop = mcpQueueTop;
exports.maskEmail = maskEmail;
exports.maskPrefix = maskPrefix;
exports.sanitizeQueryRow = sanitizeQueryRow;
exports.mcpQueriesRecent = mcpQueriesRecent;
exports.queriesRecentToolDef = queriesRecentToolDef;
exports.mcpQueriesDaily = mcpQueriesDaily;
exports.queriesDailyToolDef = queriesDailyToolDef;
const lookup_core_1 = require("../lookup-core");
const mysql_1 = require("../storage/mysql");
const unknownIpQueue_1 = require("../storage/unknownIpQueue");
const queryLog_1 = require("../storage/queryLog");
/**
 * Clamp an unknown tool argument into [min, max]. Non-numeric input falls
 * back to the default; numeric input is clamped into the bounds.
 */
function clampInt(v, min, max, fallback) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}
/** ISO-serialize a Date-or-null for stable JSON output. */
function iso(d) {
    return d ? d.toISOString() : null;
}
/**
 * MCP lookup: identical behavior to the HTTP /lookup route (including the
 * unknown_ip_queue miss side effect), but never writes query_log — MCP
 * callers have no authenticated subject to attribute the query to.
 */
async function mcpLookup(deps, ip) {
    return (0, lookup_core_1.doLookupCore)(deps.pool, deps.log, ip);
}
function lookupToolDef() {
    return {
        name: "ipquery_lookup",
        description: "Query IPQuery for the geolocation of an IPv4/IPv6 address: country, region, city, timezone, ISP and ASN. Unknown IPs are queued for multi-provider backfill.",
        inputSchema: {
            type: "object",
            properties: {
                ip: { type: "string", description: "IPv4 or IPv6 address to look up, e.g. 8.8.8.8" },
            },
            required: ["ip"],
        },
    };
}
async function mcpQueueStats(deps) {
    try {
        const s = await (0, unknownIpQueue_1.queueStats)(deps.pool);
        return { pending: s.pending, processed: s.processed, totalQueries: s.totalQueries };
    }
    catch (e) {
        deps.log.error({ err: e }, "mcpQueueStats failed");
        throw new Error(`queue stats failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
function queueStatsToolDef() {
    return {
        name: "ipquery_queue_stats",
        description: "Unknown-IP backfill queue counters: pending, processed, and total accumulated queries.",
        inputSchema: { type: "object", properties: {} },
    };
}
async function mcpEtlStatus(deps) {
    try {
        const last = await (0, mysql_1.lastEtlRun)(deps.pool);
        const queue = await mcpQueueStats(deps);
        if (!last)
            return { lastRun: null, queue };
        return {
            lastRun: {
                startedAt: iso(last.startedAt),
                finishedAt: iso(last.finishedAt ?? null),
                status: last.status,
                mergedRecords: last.mergedRecords ?? 0,
                sources: {
                    // null = the source did not run; 0 = it ran and contributed
                    // nothing. MaxMind and ip2region parsers exist but are not
                    // wired into the ETL pipeline, so their counters stay NULL.
                    maxmind: {
                        records: last.maxmindRecords ?? null,
                        builtAt: iso(last.maxmindBuiltAt ?? null),
                    },
                    ip2region: {
                        records: last.ip2regionRecords ?? null,
                        builtAt: iso(last.ip2regionBuiltAt ?? null),
                    },
                    dbip: { records: last.dbipRecords ?? 0, builtAt: iso(last.dbipBuiltAt ?? null) },
                },
            },
            queue,
        };
    }
    catch (e) {
        deps.log.error({ err: e }, "mcpEtlStatus failed");
        throw new Error(`etl status failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
function etlStatusToolDef() {
    return {
        name: "ipquery_etl_status",
        description: "Last ETL run status (per-source record counts) plus a queue summary.",
        inputSchema: { type: "object", properties: {} },
    };
}
function queueTopToolDef() {
    return {
        name: "ipquery_queue_top",
        description: "Unknown IPs with the highest query counts, pending backfill.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "How many IPs to return (1-100, default 20)" },
            },
        },
    };
}
async function mcpQueueTop(deps, limit) {
    const n = clampInt(limit, 1, 100, 20);
    try {
        const { pending, recentlyProcessed } = await (0, unknownIpQueue_1.topByQueryCount)(deps.pool, n);
        return {
            pending: pending.map((r) => ({
                ip: r.ipText,
                queryCount: Number(r.queryCount),
                lastSeenAt: iso(r.lastSeenAt),
            })),
            recentlyProcessed: recentlyProcessed.map((r) => ({
                ip: r.ipText,
                queryCount: Number(r.queryCount),
                processedAt: iso(r.processedAt),
            })),
        };
    }
    catch (e) {
        deps.log.error({ err: e }, "mcpQueueTop failed");
        throw new Error(`queue top failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
// ─── Query-log tools + redaction ──────────────────────────────────────
/** Mask an email as p***@e***.com; null/empty → null.
 *  Only the TLD survives (last dot, not first): a first-dot split would
 *  leak the whole registrable domain of a subdomain address —
 *  a@mail.example.com must come out as a***@m***.com, not a***@m***.example.com. */
function maskEmail(email) {
    if (!email)
        return null;
    const at = email.indexOf("@");
    if (at <= 0)
        return "***";
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    if (!domain)
        return `${local[0]}***@***`;
    const dot = domain.lastIndexOf(".");
    const tld = dot > 0 ? domain.slice(dot) : "";
    return `${local[0]}***@${domain[0]}***${tld}`;
}
/** Keep the first 4 chars of an API-key prefix; null/empty → null. */
function maskPrefix(prefix) {
    if (!prefix)
        return null;
    return `${prefix.slice(0, 4)}***`;
}
/**
 * Serialize a query-log row for MCP output. includePrivate=false (the
 * default from the tool layer) redacts userEmail and apiKeyPrefix; remote
 * address and IP text stay visible — they are the lookup subject, not a
 * secret. Dates are ISO-serialized.
 */
function sanitizeQueryRow(row, includePrivate) {
    return {
        id: row.id,
        ts: iso(row.ts ?? null),
        ipText: row.ipText,
        status: row.status,
        userId: row.userId,
        userAgent: row.userAgent ?? null,
        userEmail: includePrivate ? (row.userEmail ?? null) : maskEmail(row.userEmail),
        apiKeyPrefix: includePrivate ? (row.apiKeyPrefix ?? null) : maskPrefix(row.apiKeyPrefix),
    };
}
const VALID_STATUSES = ["hit", "miss", "invalid"];
async function mcpQueriesRecent(deps, args = {}) {
    const limit = clampInt(args.limit, 1, 50, 10);
    const status = typeof args.status === "string" && VALID_STATUSES.includes(args.status)
        ? args.status
        : undefined;
    const includePrivate = args.includePrivate === true;
    try {
        const { rows, total } = await (0, queryLog_1.listQueryLogs)(deps.pool, { offset: 0, limit, status });
        return { rows: rows.map((r) => sanitizeQueryRow(r, includePrivate)), total };
    }
    catch (e) {
        deps.log.error({ err: e }, "mcpQueriesRecent failed");
        throw new Error(`recent queries failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
function queriesRecentToolDef() {
    return {
        name: "ipquery_queries_recent",
        description: "Recent lookup queries from the query log, newest first. userEmail and apiKeyPrefix are redacted unless includePrivate is true.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "Rows to return (1-50, default 10)" },
                status: { type: "string", enum: ["hit", "miss", "invalid"], description: "Filter by result status" },
                includePrivate: {
                    type: "boolean",
                    description: "Return unredacted userEmail/apiKeyPrefix (default false)",
                },
            },
        },
    };
}
async function mcpQueriesDaily(deps, args = {}) {
    const days = clampInt(args.days, 1, 90, 30);
    try {
        const buckets = await (0, queryLog_1.countQueriesByDay)(deps.pool, days);
        return buckets.map((b) => ({ day: b.date, count: Number(b.total) }));
    }
    catch (e) {
        deps.log.error({ err: e }, "mcpQueriesDaily failed");
        throw new Error(`daily queries failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
function queriesDailyToolDef() {
    return {
        name: "ipquery_queries_daily",
        description: "Lookup query volume per day over the last N days (1-90, default 30).",
        inputSchema: {
            type: "object",
            properties: { days: { type: "number", description: "Window size in days (1-90, default 30)" } },
        },
    };
}
//# sourceMappingURL=tools.js.map
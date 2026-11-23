"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mcpEtlHistory = mcpEtlHistory;
exports.etlHistoryToolDef = etlHistoryToolDef;
exports.mcpProviderHealth = mcpProviderHealth;
exports.providerHealthToolDef = providerHealthToolDef;
exports.mcpAuditLog = mcpAuditLog;
exports.auditLogToolDef = auditLogToolDef;
exports.mcpRangeJobs = mcpRangeJobs;
exports.rangeJobsToolDef = rangeJobsToolDef;
// SPDX-License-Identifier: MIT
//
// The operational-data MCP tools.
//
// Everything here reads the internals of an IPQuery instance: how its
// ETL runs went, how healthy its upstream providers are, who changed
// what in the admin console, and how the range import/export jobs are
// doing. None of it is a geolocation answer, so all of it lives in the
// `ops` scope — a `lookup`-scoped token reaches none of it.
//
// The geolocation tools live in ./tools.ts; the shared `McpPool`,
// `ToolDef`, `clampInt` and the ISO serializer are imported from there
// so both halves of the server agree on them.
const tools_1 = require("./tools");
const mysql_1 = require("../storage/mysql");
const providerErrorLog_1 = require("../storage/providerErrorLog");
const auditLog_1 = require("../storage/auditLog");
const rangeImport_1 = require("../storage/rangeImport");
const rangeExportJob_1 = require("../storage/rangeExportJob");
/**
 * ETL run history, newest first.
 *
 * `ipquery_etl_status` reports the newest run only, so a question like
 * "did last night's run fail, and how many runs has this instance had
 * since?" had no answer. The rows are already there — the marketing
 * page reads them through `recentEtlRuns` — this exposes them to MCP.
 */
async function mcpEtlHistory(deps, limit) {
    const n = (0, tools_1.clampInt)(limit, 1, 100, 20);
    try {
        const runs = await (0, mysql_1.recentEtlRuns)(deps.pool, n);
        return {
            runs: runs.map((run) => ({
                id: run.id ?? 0,
                startedAt: (0, tools_1.iso)(run.startedAt ?? null),
                finishedAt: (0, tools_1.iso)(run.finishedAt ?? null),
                status: run.status,
                mergedRecords: run.mergedRecords ?? 0,
                errorMessage: run.errorMessage ?? null,
            })),
        };
    }
    catch (e) {
        deps.log.error({ err: e }, "mcpEtlHistory failed");
        throw new Error(`etl history failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
function etlHistoryToolDef() {
    return {
        name: "ipquery_etl_history",
        description: "ETL run history, newest first: status, start and finish time, merged record count and the failure reason of a failed run.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "How many runs to return (1-100, default 20)" },
            },
        },
    };
}
/** Largest window the health aggregate is willing to scan. */
const MAX_HEALTH_WINDOW_MINUTES = 7 * 24 * 60;
/** Default window: one hour, the same default the admin widget uses. */
const DEFAULT_HEALTH_WINDOW_MINUTES = 60;
/**
 * Provider health for the backfill fan-out.
 *
 * The admin console shows this on its Providers tab, but an AI client
 * driving the server could not ask — and a client watching the library
 * fill itself needs to notice that every backfill has been abstaining
 * because one provider is rate-limiting.
 *
 * The health numbers mean nothing without the breaker settings they are
 * measured against (50% failures under a 100% threshold is healthy), so
 * the two travel together.
 */
async function mcpProviderHealth(deps, args = {}) {
    const windowMinutes = (0, tools_1.clampInt)(args.windowMinutes, 1, MAX_HEALTH_WINDOW_MINUTES, DEFAULT_HEALTH_WINDOW_MINUTES);
    const windowMs = windowMinutes * 60_000;
    try {
        const [providers, breaker] = await Promise.all([
            (0, providerErrorLog_1.aggregateProviderHealthAll)(deps.pool, windowMs),
            // A breaker that cannot be read must not take the health numbers
            // down with it — the counters are the answer even when the
            // threshold is unknown.
            (0, providerErrorLog_1.getCircuitBreakerConfig)(deps.pool).catch((e) => {
                deps.log.warn({ err: e }, "mcpProviderHealth: circuit breaker config unreadable");
                return null;
            }),
        ]);
        return {
            windowMinutes,
            providers: providers.map((p) => ({
                providerName: p.providerName,
                windowMs: p.windowMs,
                calls: p.calls,
                errors429: p.errors429,
                errorsOther: p.errorsOther,
                failureRatePct: p.failureRatePct,
                rateLimitedRatePct: p.rateLimitedRatePct,
                lastCallAt: (0, tools_1.iso)(p.lastCallAt),
            })),
            circuitBreaker: breaker,
        };
    }
    catch (e) {
        deps.log.error({ err: e }, "mcpProviderHealth failed");
        throw new Error(`provider health failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
function providerHealthToolDef() {
    return {
        name: "ipquery_provider_health",
        description: "Health of the geolocation providers used by the unknown-IP backfill: call counts, rate-limit and other failures, failure rates, last call time, plus the circuit-breaker settings they are judged against.",
        inputSchema: {
            type: "object",
            properties: {
                windowMinutes: {
                    type: "number",
                    description: "Size of the window to measure (1-10080 minutes, default 60)",
                },
            },
        },
    };
}
/** Largest page the audit tool will ask the database for. */
const MAX_AUDIT_LIMIT = 100;
/** Default page size. */
const DEFAULT_AUDIT_LIMIT = 20;
/**
 * The administrative audit trail.
 *
 * Every administrative action lands in `admin_audit_log` — approving an
 * MCP token, importing ranges, changing the circuit breaker. The admin
 * console reads it at `/admin/audit-log`; this makes it reachable from
 * an MCP client.
 *
 * The log names operators and their email addresses, so it sits in the
 * `ops` scope: a `lookup` token answers geolocation questions and has
 * no business reading who ran what.
 */
async function mcpAuditLog(deps, args = {}) {
    const limit = (0, tools_1.clampInt)(args.limit, 1, MAX_AUDIT_LIMIT, DEFAULT_AUDIT_LIMIT);
    // A filter that is not a string would reach the query as a bound
    // parameter of the wrong type; ignore it rather than fail the call.
    const action = typeof args.action === "string" && args.action.trim() !== "" ? args.action.trim() : undefined;
    try {
        const { rows, total } = await (0, auditLog_1.listAuditLog)(deps.pool, {
            offset: 0,
            limit,
            ...(action ? { action } : {}),
        });
        return {
            rows: rows.map((row) => ({
                id: row.id,
                actorEmail: row.actor_email,
                action: row.action,
                targetType: row.target_type,
                targetId: row.target_id,
                metadata: row.metadata,
                ip: row.ip,
                statusCode: row.status_code,
                createdAt: (0, tools_1.iso)(row.created_at),
            })),
            total,
        };
    }
    catch (e) {
        deps.log.error({ err: e }, "mcpAuditLog failed");
        throw new Error(`audit log failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
function auditLogToolDef() {
    return {
        name: "ipquery_audit_log",
        description: "Administrative audit trail, newest first: who ran which action, on what target, when, and from where. Operational data — names operator email addresses.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "How many entries to return (1-100, default 20)" },
                action: { type: "string", description: "Filter by action name, e.g. mcp_token.approve" },
            },
        },
    };
}
/** Largest page of jobs the tool will ask the database for. */
const MAX_RANGE_JOB_LIMIT = 50;
/** Default page size. */
const DEFAULT_RANGE_JOB_LIMIT = 10;
function toImportEntry(job) {
    return {
        id: job.id,
        mode: job.mode,
        source: job.source,
        status: job.status,
        rowsDone: job.rowsDone,
        declaredRows: job.declaredRows,
        rowsWritten: job.rowsWritten,
        preserved: job.preserved,
        errorMessage: job.errorMessage,
        startedAt: (0, tools_1.iso)(job.startedAt),
        finishedAt: (0, tools_1.iso)(job.finishedAt),
    };
}
function toExportEntry(job) {
    return {
        id: job.id,
        filename: job.filename,
        countryCode: job.countryCode,
        status: job.status,
        rows: job.rows,
        bytes: job.bytes,
        errorMessage: job.errorMessage,
        startedAt: (0, tools_1.iso)(job.startedAt),
        finishedAt: (0, tools_1.iso)(job.finishedAt),
    };
}
/**
 * The state of the range import and export jobs.
 *
 * A library-sized import takes hours and a library-sized export writes
 * around two gigabytes, so both run detached: the request that starts
 * the job returns immediately and the work continues. Both write their
 * state to a table, so the state survives a restart.
 *
 * The admin console shows both at `/admin/ranges`; this makes them
 * reachable from an MCP client that needs to know whether the ranges
 * table is mid-swap.
 */
async function mcpRangeJobs(deps, args = {}) {
    const limit = (0, tools_1.clampInt)(args.limit, 1, MAX_RANGE_JOB_LIMIT, DEFAULT_RANGE_JOB_LIMIT);
    try {
        // Both lists are independent — read them together rather than
        // making the client wait for two round trips.
        const [imports, exports] = await Promise.all([
            (0, rangeImport_1.listRangeImports)(deps.pool, limit),
            (0, rangeExportJob_1.listRangeExports)(deps.pool, limit),
        ]);
        return { imports: imports.map(toImportEntry), exports: exports.map(toExportEntry) };
    }
    catch (e) {
        deps.log.error({ err: e }, "mcpRangeJobs failed");
        throw new Error(`range jobs failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
function rangeJobsToolDef() {
    return {
        name: "ipquery_range_jobs",
        description: "State of the range import and export jobs: mode, status, progress and failure reason for each, plus the exported file's name, row count and size.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "How many jobs of each kind to return (1-50, default 10)" },
            },
        },
    };
}
//# sourceMappingURL=ops-tools.js.map
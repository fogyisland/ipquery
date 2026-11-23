"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeLastRun = serializeLastRun;
exports.buildToolRegistrations = buildToolRegistrations;
// SPDX-License-Identifier: MIT
// Unified registration table: pairs every tool definition with a handler
// that returns MCP text content. The stdio server entry consumes this.
const tools_1 = require("./tools");
const ops_tools_1 = require("./ops-tools");
const mysql_1 = require("../storage/mysql");
const etlSourceReport_1 = require("../storage/etlSourceReport");
const ip_1 = require("../ip");
/** Structured error result so the server layer can flag isError without
 *  sniffing serialized text. */
function errorResult(message, code) {
    return code ? { isErrorHint: true, code, message } : { isErrorHint: true, message };
}
/** Wrap a tool call: thrown errors become structured results, never escapes.
 *  Tool payloads are plain JSON objects; ToolResult's index signature accepts
 *  them once widened through unknown. Typed business codes (e.g. the lookup
 *  `not_found` miss) travel alongside so the server layer can downgrade
 *  them to a normal result — a miss is an answer, not a tool failure. */
async function safe(run) {
    try {
        return (await run());
    }
    catch (e) {
        const code = e.code;
        return errorResult(e instanceof Error ? e.message : String(e), typeof code === "string" ? code : undefined);
    }
}
/** ISO-serialize the shared lastRun shape (used by ipquery_stats and the
 *  etl-status tool so the two outputs cannot drift). */
function serializeLastRun(last) {
    return {
        startedAt: last.startedAt?.toISOString() ?? null,
        finishedAt: last.finishedAt?.toISOString() ?? null,
        status: last.status,
        mergedRecords: last.mergedRecords ?? 0,
        // Derived from the pipeline's own file table — the same helper the
        // HTTP /stats route uses, so the two cannot drift apart.
        sources: (0, etlSourceReport_1.buildEtlSourceReport)(last),
    };
}
async function statsHandler(deps) {
    const last = await (0, mysql_1.lastEtlRun)(deps.pool);
    if (!last)
        return { lastRun: null };
    return { lastRun: serializeLastRun(last) };
}
function lookupHandler(deps) {
    return async (args) => {
        const ip = args.ip;
        if (typeof ip !== "string" || !(0, ip_1.isValidIp)(ip)) {
            return errorResult(`invalid ip: ${typeof ip === "string" ? ip : "(missing)"}`);
        }
        return safe(() => (0, tools_1.mcpLookup)(deps, ip));
    };
}
function buildToolRegistrations(deps) {
    return [
        { def: (0, tools_1.lookupToolDef)(), handler: lookupHandler(deps) },
        {
            def: (0, tools_1.lookupBatchToolDef)(),
            handler: (args) => safe(() => (0, tools_1.mcpLookupBatch)(deps, args)),
        },
        {
            def: {
                name: "ipquery_stats",
                description: "Library summary: last ETL run status and per-source record counts.",
                inputSchema: { type: "object", properties: {} },
            },
            handler: () => safe(() => statsHandler(deps)),
        },
        { def: (0, tools_1.etlStatusToolDef)(), handler: () => safe(() => (0, tools_1.mcpEtlStatus)(deps)) },
        {
            def: (0, tools_1.etlSourcesToolDef)(),
            handler: (args) => safe(() => (0, tools_1.mcpEtlSources)(deps, args.runId)),
        },
        {
            def: (0, ops_tools_1.etlHistoryToolDef)(),
            handler: (args) => safe(() => (0, ops_tools_1.mcpEtlHistory)(deps, args.limit)),
        },
        {
            def: (0, ops_tools_1.providerHealthToolDef)(),
            handler: (args) => safe(() => (0, ops_tools_1.mcpProviderHealth)(deps, args)),
        },
        {
            def: (0, ops_tools_1.auditLogToolDef)(),
            handler: (args) => safe(() => (0, ops_tools_1.mcpAuditLog)(deps, args)),
        },
        {
            def: (0, ops_tools_1.rangeJobsToolDef)(),
            handler: (args) => safe(() => (0, ops_tools_1.mcpRangeJobs)(deps, args)),
        },
        { def: (0, tools_1.queueStatsToolDef)(), handler: () => safe(() => (0, tools_1.mcpQueueStats)(deps)) },
        {
            def: (0, tools_1.queueTopToolDef)(),
            handler: (args) => safe(() => (0, tools_1.mcpQueueTop)(deps, args.limit)),
        },
        {
            def: (0, tools_1.queriesRecentToolDef)(),
            handler: (args) => safe(() => (0, tools_1.mcpQueriesRecent)(deps, args)),
        },
        {
            def: (0, tools_1.queriesDailyToolDef)(),
            handler: (args) => safe(() => (0, tools_1.mcpQueriesDaily)(deps, args)),
        },
    ];
}
//# sourceMappingURL=server-tools.js.map
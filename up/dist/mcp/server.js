"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// SPDX-License-Identifier: MIT
// MCP stdio server entry. stdio is owned by the MCP protocol — all
// diagnostics go to stderr. Launched by AI clients as a subprocess:
//   node dist/mcp/server.js
const dotenv_1 = require("dotenv");
const env_1 = require("./env");
(0, dotenv_1.config)({ path: `${(0, env_1.resolveProjectRoot)()}/.env`, quiet: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const config_1 = require("../config");
const mysql_1 = require("../storage/mysql");
const server_tools_1 = require("./server-tools");
const tool_names_1 = require("./tool-names");
const SERVER_INFO = { name: "ipquery", version: "1.0.0" };
function failFast(message, err) {
    console.error(`[ipquery-mcp] ${message}`, err ?? "");
    process.exit(1);
}
async function main() {
    let cfg;
    try {
        cfg = (0, config_1.loadConfig)();
    }
    catch (e) {
        failFast("config load failed — is .env present in the project root?", e);
    }
    // Reuse the shared pool factory so the MCP server picks up the same
    // driver settings as the web/API server — notably `timezone: "Z"`,
    // without which mysql2 renders DATETIME values in the process's local
    // timezone and every ISO-serialized timestamp drifts by the offset.
    const pool = (0, mysql_1.createPool)({ ...cfg, db: { ...cfg.db, poolSize: 2 } });
    // Fail fast if the DB is unreachable instead of failing per-tool later.
    try {
        await pool.query("SELECT 1");
    }
    catch (e) {
        failFast(`database unreachable at ${cfg.db.host}:${cfg.db.port}/${cfg.db.database}`, e);
    }
    const deps = {
        pool,
        log: {
            warn: (obj, msg) => console.error("[ipquery-mcp][warn]", msg, obj),
            error: (obj, msg) => console.error("[ipquery-mcp][error]", msg, obj),
        },
    };
    const registrations = (0, server_tools_1.buildToolRegistrations)(deps);
    const byName = new Map(registrations.map((r) => [r.def.name, r]));
    const server = new index_js_1.Server(SERVER_INFO, { capabilities: { tools: {} } });
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
        tools: registrations.map((r) => ({
            name: r.def.name,
            description: r.def.description,
            inputSchema: r.def.inputSchema,
        })),
    }));
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const reg = byName.get(name);
        if (!reg) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ isErrorHint: true, message: `Unknown tool: ${name}. Available: ${tool_names_1.TOOL_NAMES.join(", ")}` }, null, 2),
                    },
                ],
                isError: true,
            };
        }
        const result = await reg.handler(request.params.arguments ?? {});
        // The typed isErrorHint flag travels on the result object itself — no
        // sniffing of serialized text, so JSON formatting changes stay safe.
        // A `not_found` lookup is a successful tool call with an empty answer
        // (the errorResult text describes the miss), so it must NOT set the
        // protocol-level isError flag — that would make clients treat a
        // legitimate "unknown IP" as a tool failure.
        const isNotFound = result.code === "not_found";
        const text = JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }], isError: result.isErrorHint === true && !isNotFound };
    });
    const shutdown = async (signal) => {
        console.error(`[ipquery-mcp] received ${signal}, shutting down`);
        try {
            await pool.end();
        }
        catch (e) {
            console.error("[ipquery-mcp] pool.end failed:", e);
        }
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error(`[ipquery-mcp] ${SERVER_INFO.name} v${SERVER_INFO.version} ready (${tool_names_1.TOOL_NAMES.length} tools)`);
}
main().catch((e) => failFast("fatal error during startup", e));
//# sourceMappingURL=server.js.map
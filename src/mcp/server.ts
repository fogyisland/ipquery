// SPDX-License-Identifier: MIT
// MCP stdio server entry. stdio is owned by the MCP protocol — all
// diagnostics go to stderr. Launched by AI clients as a subprocess:
//   node dist/mcp/server.js
import { config as dotenvConfig } from "dotenv";
import { resolveProjectRoot } from "./env";

dotenvConfig({ path: `${resolveProjectRoot()}/.env`, quiet: true });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
import { loadConfig } from "../config";
import { buildToolRegistrations } from "./server-tools";
import { TOOL_NAMES } from "./tool-names";
import type { McpPool } from "./tools";

const SERVER_INFO = { name: "ipquery", version: "1.0.0" };

function failFast(message: string, err?: unknown): never {
  console.error(`[ipquery-mcp] ${message}`, err ?? "");
  process.exit(1);
}

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    failFast("config load failed — is .env present in the project root?", e);
  }

  const pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
    connectionLimit: 2,
  });

  // Fail fast if the DB is unreachable instead of failing per-tool later.
  try {
    await pool.query("SELECT 1");
  } catch (e) {
    failFast(`database unreachable at ${cfg.db.host}:${cfg.db.port}/${cfg.db.database}`, e);
  }

  const deps: McpPool = {
    pool,
    log: {
      warn: (obj, msg) => console.error("[ipquery-mcp][warn]", msg, obj),
      error: (obj, msg) => console.error("[ipquery-mcp][error]", msg, obj),
    },
  };

  const registrations = buildToolRegistrations(deps);
  const byName = new Map(registrations.map((r) => [r.def.name, r]));

  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registrations.map((r) => ({
      name: r.def.name,
      description: r.def.description,
      inputSchema: r.def.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const reg = byName.get(name);
    if (!reg) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}. Available: ${TOOL_NAMES.join(", ")}` }],
        isError: true,
      };
    }
    const text = await reg.handler(request.params.arguments ?? {});
    // Handlers already wrap failures in {"isErrorHint":true,...} JSON; pass
    // that through as a tool error so clients render it as a failure.
    const isError = text.includes('"isErrorHint": true');
    return { content: [{ type: "text", text }], isError };
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[ipquery-mcp] received ${signal}, shutting down`);
    try {
      await pool.end();
    } catch (e) {
      console.error("[ipquery-mcp] pool.end failed:", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[ipquery-mcp] ${SERVER_INFO.name} v${SERVER_INFO.version} ready (${TOOL_NAMES.length} tools)`,
  );
}

main().catch((e) => failFast("fatal error during startup", e));

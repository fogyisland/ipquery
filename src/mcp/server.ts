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
import { loadConfig } from "../config";
import { createPool } from "../storage/mysql";
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

  // Reuse the shared pool factory so the MCP server picks up the same
  // driver settings as the web/API server — notably `timezone: "Z"`,
  // without which mysql2 renders DATETIME values in the process's local
  // timezone and every ISO-serialized timestamp drifts by the offset.
  const pool = createPool({ ...cfg, db: { ...cfg.db, poolSize: 2 } });

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
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { isErrorHint: true, message: `Unknown tool: ${name}. Available: ${TOOL_NAMES.join(", ")}` },
              null,
              2,
            ),
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
    const isNotFound = (result as { code?: string }).code === "not_found";
    const text = JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }], isError: result.isErrorHint === true && !isNotFound };
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

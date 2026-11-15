"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPS_SCOPE_TOOLS = exports.LOOKUP_SCOPE_TOOLS = void 0;
exports.authenticate = authenticate;
// SPDX-License-Identifier: MIT
// Authentication for the MCP server.
//
// The stdio transport has no request headers, so a credential cannot be
// attached to an individual tool call — it has to be presented when the
// server process starts. The client therefore passes it in the
// environment:
//
//   { "mcpServers": { "ipquery": { "command": "node",
//       "args": ["…/dist/mcp/server.js"],
//       "env": { "IPQUERY_MCP_TOKEN": "ipqt_…" } } } }
//
// Two modes:
//
//   Authenticated — a token is supplied. The token must exist, be
//   `approved` and not be revoked. Its scope decides which tools the
//   client can even see.
//
//   Local — no token is supplied. The server runs unauthenticated, but
//   ONLY when the operator has not demanded a token
//   (MCP_REQUIRE_TOKEN=true turns this off). This keeps `node
//   dist/mcp/server.js` working for a developer on the box, without
//   leaving the server open to anyone who can reach the database.
const mcpTokens_1 = require("../storage/mcpTokens");
const tokens_1 = require("../web/auth/tokens");
/** Tools a `lookup`-scoped token may reach. Everything else is
 *  operational data and needs an `ops` scope. */
exports.LOOKUP_SCOPE_TOOLS = ["ipquery_lookup"];
/** Tools that expose operational data: query logs (with user emails),
 *  queue depths and ETL state. */
exports.OPS_SCOPE_TOOLS = [
    "ipquery_lookup",
    "ipquery_stats",
    "ipquery_etl_status",
    "ipquery_queue_stats",
    "ipquery_queue_top",
    "ipquery_queries_recent",
    "ipquery_queries_daily",
];
/**
 * Resolve the session's authorization.
 *
 * Throws when a token was supplied but is not usable — a rejected or
 * revoked token is an error the operator needs to see, not a silent
 * downgrade to an unauthenticated session.
 */
async function authenticate(pool, rawToken, requireToken) {
    const token = (rawToken ?? "").trim();
    if (!token) {
        if (requireToken) {
            throw new Error("MCP_REQUIRE_TOKEN is enabled but no token was supplied. " +
                "Set IPQUERY_MCP_TOKEN to an approved MCP token.");
        }
        return {
            mode: "local",
            token: null,
            scope: "ops",
            allowedTools: new Set(exports.OPS_SCOPE_TOOLS),
        };
    }
    const found = await (0, mcpTokens_1.findApprovedMcpTokenByHash)(pool, (0, tokens_1.hashToken)(token));
    if (!found) {
        throw new Error("MCP token rejected: the token is unknown, not yet approved, or has been revoked.");
    }
    // Stamp the token's last use. A failure here must not break the call —
    // the credential already proved itself.
    try {
        await (0, mcpTokens_1.touchMcpToken)(pool, found.id);
    }
    catch (e) {
        console.error("[ipquery-mcp][warn] could not stamp token usage:", e);
    }
    const allowed = found.scope === "ops" ? exports.OPS_SCOPE_TOOLS : exports.LOOKUP_SCOPE_TOOLS;
    return {
        mode: "token",
        token: found,
        scope: found.scope,
        allowedTools: new Set(allowed),
    };
}
//# sourceMappingURL=auth.js.map
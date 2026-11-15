import type { Pool } from "mysql2/promise";
import type { McpToken, McpTokenScope } from "../types";
/** Tools a `lookup`-scoped token may reach. Everything else is
 *  operational data and needs an `ops` scope. */
export declare const LOOKUP_SCOPE_TOOLS: readonly ["ipquery_lookup"];
/** Tools that expose operational data: query logs (with user emails),
 *  queue depths and ETL state. */
export declare const OPS_SCOPE_TOOLS: readonly ["ipquery_lookup", "ipquery_stats", "ipquery_etl_status", "ipquery_queue_stats", "ipquery_queue_top", "ipquery_queries_recent", "ipquery_queries_daily"];
export type McpAuthMode = "token" | "local";
export interface McpAuth {
    mode: McpAuthMode;
    /** The authenticated token, when mode is "token". */
    token: McpToken | null;
    scope: McpTokenScope;
    /** Tool names this session may call. */
    allowedTools: ReadonlySet<string>;
}
/**
 * Resolve the session's authorization.
 *
 * Throws when a token was supplied but is not usable — a rejected or
 * revoked token is an error the operator needs to see, not a silent
 * downgrade to an unauthenticated session.
 */
export declare function authenticate(pool: Pool, rawToken: string | undefined, requireToken: boolean): Promise<McpAuth>;

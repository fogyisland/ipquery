import type { Pool } from "mysql2/promise";
import type { McpToken, McpTokenScope, McpTokenStatus } from "../types";
export declare function createMcpToken(pool: Pool, userId: number, label: string, tokenHash: string, tokenPrefix: string, scope: McpTokenScope): Promise<McpToken>;
export declare function findMcpTokenById(pool: Pool, id: number): Promise<McpToken | null>;
/**
 * Look up a token by hash for authentication. Only an `approved` token
 * that has not been revoked can authenticate — a pending, rejected or
 * revoked token returns null here, which is the single choke point that
 * keeps unapproved credentials out of the MCP server.
 */
export declare function findApprovedMcpTokenByHash(pool: Pool, tokenHash: string): Promise<McpToken | null>;
export declare function listMcpTokensForUser(pool: Pool, userId: number): Promise<McpToken[]>;
export interface ListMcpTokensOptions {
    offset: number;
    limit: number;
    status?: McpTokenStatus;
    scope?: McpTokenScope;
}
export declare function listAllMcpTokens(pool: Pool, opts: ListMcpTokensOptions): Promise<{
    rows: (McpToken & {
        ownerEmail: string;
    })[];
    total: number;
}>;
export declare function countMcpTokensByStatus(pool: Pool): Promise<Record<McpTokenStatus, number>>;
/**
 * Approve or reject a pending token. Returns the number of rows changed
 * so the caller can tell "I decided it" from "it was already decided" —
 * a token that was already approved must not be silently re-decided.
 */
export declare function decideMcpToken(pool: Pool, id: number, decision: "approved" | "rejected", adminUserId: number, note: string | null): Promise<number>;
/** Withdraw an approved token. Already-revoked tokens are no-ops. */
export declare function revokeMcpToken(pool: Pool, id: number): Promise<number>;
/** Bulk-revoke up to 100 approved tokens in one UPDATE.
 *  Returns the number of rows actually revoked. */
export declare function revokeMcpTokensBulk(pool: Pool, ids: number[]): Promise<number>;
export declare function touchMcpToken(pool: Pool, id: number): Promise<void>;
/** Clear the throttle state. Test-only. */
export declare function _resetMcpTokenTouchThrottle(): void;

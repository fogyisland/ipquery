import type { Pool } from "mysql2/promise";
import type { LookupResult } from "./types";
/** Minimal logger surface doLookupCore needs (satisfied by fastify's logger). */
export interface CoreLogger {
    warn: (obj: unknown, msg: string) => void;
}
export declare function doLookupCore(pool: Pool, log: CoreLogger, ip: string): Promise<LookupResult>;
/** Largest batch one call will answer. */
export declare const MAX_BATCH_SIZE = 100;
/** One address inside a batch answer. */
export interface BatchLookupEntry {
    ip: string;
    /** False when the address was malformed or not in the library. */
    found: boolean;
    /** The lookup result, when the address was found. */
    result?: LookupResult;
    /** Why the address was not found: "invalid_ip" or "not_found". */
    error?: string;
}
export interface BatchLookupResult {
    results: BatchLookupEntry[];
    /** How many addresses were asked about. */
    total: number;
    /** How many of them were in the library. */
    found: number;
    /** How many were not — malformed or unknown. */
    notFound: number;
}
/**
 * Look several addresses up in one call.
 *
 * The batch never fails as a whole. One malformed address does not cost
 * the caller the other ninety-nine answers: the bad one is marked and
 * the rest land. A batch that died on the first bad address would be
 * worse than no batch at all — the caller's job is reconciliation, and a
 * single malformed line in a log file must not cost them the file.
 *
 * The HTTP API and the MCP server both call this, so an answer means the
 * same thing whichever way it was asked for.
 */
export declare function doLookupBatchCore(pool: Pool, log: CoreLogger, ips: readonly string[]): Promise<BatchLookupResult>;

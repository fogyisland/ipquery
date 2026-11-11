import type { Pool } from "mysql2/promise";
import type { ApiKey } from "../types";
export declare function createApiKey(pool: Pool, userId: number, label: string, keyHash: string, keyPrefix: string): Promise<ApiKey>;
export declare function findApiKeyById(pool: Pool, id: number): Promise<ApiKey | null>;
export declare function findActiveApiKeyByHash(pool: Pool, keyHash: string): Promise<ApiKey | null>;
export declare function touchApiKey(pool: Pool, id: number): Promise<void>;
/**
 * Clear the throttle state. Test-only.
 */
export declare function _resetApiKeyTouchThrottle(): void;
export declare function revokeApiKey(pool: Pool, id: number): Promise<void>;
/** Bulk-revoke up to 100 keys in one UPDATE. Returns the number of rows
 *  actually revoked (already-revoked keys are no-ops and don't count).
 *  The caller caps the input length; we re-cap defensively in case the
 *  caller forgets. */
export declare function revokeApiKeysBulk(pool: Pool, ids: number[]): Promise<number>;
export declare function listApiKeysForUser(pool: Pool, userId: number): Promise<ApiKey[]>;
export declare function listAllApiKeys(pool: Pool, opts: {
    offset: number;
    limit: number;
    userId?: number;
}): Promise<{
    rows: (ApiKey & {
        ownerEmail: string;
    })[];
    total: number;
}>;
export declare function countActiveApiKeys(pool: Pool): Promise<number>;

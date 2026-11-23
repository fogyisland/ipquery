import type { Pool } from "mysql2/promise";
/** How long a stored count is trusted before a background refresh rewrites it. */
export declare const RANGE_COUNT_MAX_AGE_MS: number;
export interface RangeCount {
    value: number;
    /** "exact" when it came from a real COUNT(*); "estimate" when it came from
     *  index statistics and may be a few percent off. */
    kind: "exact" | "estimate";
    /** When the exact value was last written, null for an estimate. */
    syncedAt: Date | null;
}
/**
 * Recompute the count exactly and store it. Call after anything that swaps or
 * bulk-writes `ip_ranges`. Never throws: a failed refresh leaves the previous
 * value in place, and the next page render falls back to the estimate.
 */
export declare function refreshRangeCount(pool: Pool): Promise<RangeCount | null>;
/** The stored count, without consulting the table. Null when never written. */
export declare function readStoredRangeCount(pool: Pool): Promise<RangeCount | null>;
/**
 * The count to show on a page. Order: stored exact value, then the
 * `information_schema` estimate, then (only if that is unavailable) an exact
 * count. No path here runs COUNT(*) on a normal page render.
 */
export declare function getRangeCount(pool: Pool): Promise<RangeCount>;

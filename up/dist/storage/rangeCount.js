"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RANGE_COUNT_MAX_AGE_MS = void 0;
exports.refreshRangeCount = refreshRangeCount;
exports.readStoredRangeCount = readStoredRangeCount;
exports.getRangeCount = getRangeCount;
const settings_1 = require("./settings");
const COUNT_KEY = "ip_ranges_count";
const SYNCED_KEY = "ip_ranges_count_at";
/** How long a stored count is trusted before a background refresh rewrites it. */
exports.RANGE_COUNT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/**
 * Recompute the count exactly and store it. Call after anything that swaps or
 * bulk-writes `ip_ranges`. Never throws: a failed refresh leaves the previous
 * value in place, and the next page render falls back to the estimate.
 */
async function refreshRangeCount(pool) {
    try {
        const [rows] = await pool.query("SELECT COUNT(*) AS c FROM ip_ranges");
        const value = Number(rows[0]?.c ?? 0);
        const now = new Date().toISOString();
        await Promise.all([(0, settings_1.setSetting)(pool, COUNT_KEY, String(value)), (0, settings_1.setSetting)(pool, SYNCED_KEY, now)]);
        return { value, kind: "exact", syncedAt: new Date(now) };
    }
    catch (err) {
        console.warn(`[range-count] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/** The stored count, without consulting the table. Null when never written. */
async function readStoredRangeCount(pool) {
    const [raw, syncedRaw] = await Promise.all([(0, settings_1.getSetting)(pool, COUNT_KEY), (0, settings_1.getSetting)(pool, SYNCED_KEY)]);
    if (raw === null)
        return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
        return null;
    const syncedAt = syncedRaw ? new Date(syncedRaw) : null;
    return {
        value,
        kind: "exact",
        syncedAt: syncedAt && !Number.isNaN(syncedAt.getTime()) ? syncedAt : null,
    };
}
/**
 * The count to show on a page. Order: stored exact value, then the
 * `information_schema` estimate, then (only if that is unavailable) an exact
 * count. No path here runs COUNT(*) on a normal page render.
 */
async function getRangeCount(pool) {
    const stored = await readStoredRangeCount(pool).catch(() => null);
    if (stored !== null) {
        // A very old stored value is still better than a 3-second COUNT(*): it is
        // refreshed by the timer and after every bulk write. Refresh it in the
        // background so this render stays fast and the next one is exact again.
        if (stored.syncedAt === null || Date.now() - stored.syncedAt.getTime() > exports.RANGE_COUNT_MAX_AGE_MS) {
            void refreshRangeCount(pool);
        }
        return stored;
    }
    try {
        const [rows] = await pool.query(`SELECT table_rows AS c FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'ip_ranges'`);
        const value = Number(rows[0]?.c ?? 0);
        if (Number.isFinite(value) && value > 0) {
            // The estimate is good enough to render, and an exact refresh is queued
            // so the next render reports the real number.
            void refreshRangeCount(pool);
            return { value, kind: "estimate", syncedAt: null };
        }
    }
    catch {
        // information_schema can be unavailable behind a restricted account; fall
        // through to the exact count rather than showing zero.
    }
    const fresh = await refreshRangeCount(pool);
    return fresh ?? { value: 0, kind: "exact", syncedAt: null };
}
//# sourceMappingURL=rangeCount.js.map
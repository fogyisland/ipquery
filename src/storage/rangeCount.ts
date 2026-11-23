// SPDX-License-Identifier: MIT
//
// A cheap answer to "how many rows does ip_ranges hold?".
//
// `SELECT COUNT(*) FROM ip_ranges` on the real library (8.15M rows, InnoDB)
// takes ~3.2 seconds, and it is not the count itself that is slow — InnoDB has
// no row-count metadata it can trust, so it walks the whole table. That number
// was being asked for on every `/admin` render (~2.9s per page), on every `/`
// render (~2.7s), and every 30 seconds by the console's htmx auto-refresh. A
// page whose only job is to show a dashboard took seconds to appear, and kept
// paying that price for as long as a tab stayed open.
//
// So the count is treated as what it actually is: a derived value that changes
// only when the table changes in bulk (an ETL swap, a range import, the demo
// seed). It is stored in `settings` and read back as one row (~1ms). The
// stored value is refreshed:
//   · after every run that swaps the table (ETL, import) — those runs already
//     take minutes, so one more exact count is noise;
//   · on server boot, in the background;
//   · every few hours, in case something else wrote rows (a backfill's
//     consensus insert, a hand-run SQL statement).
//
// When nothing is stored yet (a fresh install, or the first request after an
// upgrade) the reader falls back to `information_schema`, which answers from
// index statistics in single-digit milliseconds and is within a few percent.
// It never blocks a page on an exact count.
import type { Pool } from "mysql2/promise";
import { getSetting, setSetting } from "./settings";

const COUNT_KEY = "ip_ranges_count";
const SYNCED_KEY = "ip_ranges_count_at";

/** How long a stored count is trusted before a background refresh rewrites it. */
export const RANGE_COUNT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

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
export async function refreshRangeCount(pool: Pool): Promise<RangeCount | null> {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS c FROM ip_ranges");
    const value = Number((rows as Array<{ c: unknown }>)[0]?.c ?? 0);
    const now = new Date().toISOString();
    await Promise.all([setSetting(pool, COUNT_KEY, String(value)), setSetting(pool, SYNCED_KEY, now)]);
    return { value, kind: "exact", syncedAt: new Date(now) };
  } catch (err) {
    console.warn(`[range-count] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The stored count, without consulting the table. Null when never written. */
export async function readStoredRangeCount(pool: Pool): Promise<RangeCount | null> {
  const [raw, syncedRaw] = await Promise.all([getSetting(pool, COUNT_KEY), getSetting(pool, SYNCED_KEY)]);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
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
export async function getRangeCount(pool: Pool): Promise<RangeCount> {
  const stored = await readStoredRangeCount(pool).catch(() => null);
  if (stored !== null) {
    // A very old stored value is still better than a 3-second COUNT(*): it is
    // refreshed by the timer and after every bulk write. Refresh it in the
    // background so this render stays fast and the next one is exact again.
    if (stored.syncedAt === null || Date.now() - stored.syncedAt.getTime() > RANGE_COUNT_MAX_AGE_MS) {
      void refreshRangeCount(pool);
    }
    return stored;
  }

  try {
    const [rows] = await pool.query(
      `SELECT table_rows AS c FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'ip_ranges'`,
    );
    const value = Number((rows as Array<{ c: unknown }>)[0]?.c ?? 0);
    if (Number.isFinite(value) && value > 0) {
      // The estimate is good enough to render, and an exact refresh is queued
      // so the next render reports the real number.
      void refreshRangeCount(pool);
      return { value, kind: "estimate", syncedAt: null };
    }
  } catch {
    // information_schema can be unavailable behind a restricted account; fall
    // through to the exact count rather than showing zero.
  }

  const fresh = await refreshRangeCount(pool);
  return fresh ?? { value: 0, kind: "exact", syncedAt: null };
}

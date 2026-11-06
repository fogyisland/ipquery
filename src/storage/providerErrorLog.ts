// SPDX-License-Identifier: MIT
//
// provider_error_log: per-failure audit trail for the IP-geolocation
// providers. Read by the /admin/unknown-ips "Failure Logs" tab; written
// by the backfill + random-gen flows (and by the circuit breaker when
// it auto-disables a provider). See migration 017.

import type { Pool, RowDataPacket } from "mysql2/promise";
import { getSetting, setSetting } from "./settings";
import { PROVIDER_CATALOG } from "./ingestProviders";

export interface ProviderErrorRow {
  id: number;
  providerName: string;
  ipText: string;
  mode: "auto" | "manual" | "random";
  errorCode: string;
  reason: string;
  rawResponse: string | null;
  ts: Date;
  retryCount: number;
}

export interface ProviderErrorInsert {
  providerName: string;
  ipText: string;
  mode: "auto" | "manual" | "random";
  errorCode: string;
  reason: string;
  rawResponse?: string | null;
  retryCount?: number;
}

export interface ProviderErrorFilter {
  providerName?: string;
  errorCode?: string;
  mode?: "auto" | "manual" | "random";
  sinceMs?: number; // epoch ms — only rows with ts >= sinceMs
  limit?: number; // default 200, hard-capped at 500
}

function rowToError(r: RowDataPacket): ProviderErrorRow {
  return {
    id: Number(r.id),
    providerName: String(r.provider_name),
    ipText: String(r.ip_text),
    mode: String(r.mode) as ProviderErrorRow["mode"],
    errorCode: String(r.error_code),
    reason: String(r.reason),
    rawResponse: r.raw_response == null ? null : String(r.raw_response),
    ts: new Date(r.ts),
    retryCount: Number(r.retry_count),
  };
}

export async function recordProviderError(pool: Pool, row: ProviderErrorInsert): Promise<void> {
  await pool.query(
    `INSERT INTO provider_error_log
       (provider_name, ip_text, mode, error_code, reason, raw_response, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.providerName,
      row.ipText,
      row.mode,
      row.errorCode,
      row.reason.slice(0, 255),
      row.rawResponse ? row.rawResponse.slice(0, 512) : null,
      row.retryCount ?? 1,
    ],
  );
}

export async function queryProviderErrors(
  pool: Pool,
  filter: ProviderErrorFilter = {},
): Promise<ProviderErrorRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.providerName) {
    where.push("provider_name = ?");
    args.push(filter.providerName);
  }
  if (filter.errorCode) {
    where.push("error_code = ?");
    args.push(filter.errorCode);
  }
  if (filter.mode) {
    where.push("mode = ?");
    args.push(filter.mode);
  }
  if (filter.sinceMs) {
    where.push("ts >= FROM_UNIXTIME(? / 1000)");
    args.push(filter.sinceMs);
  }
  const limit = Math.min(filter.limit ?? 200, 500);
  const sql = `SELECT id, provider_name, ip_text, mode, error_code, reason,
                      raw_response, ts, retry_count
                 FROM provider_error_log
                ${where.length ? "WHERE " + where.join(" AND ") : ""}
                ORDER BY ts DESC, id DESC
                LIMIT ${limit}`;
  const [rows] = await pool.query<RowDataPacket[]>(sql, args);
  return rows.map(rowToError);
}

export async function distinctErrorCodes(pool: Pool): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT error_code FROM provider_error_log
       WHERE ts >= (NOW() - INTERVAL 30 DAY)
       ORDER BY error_code`,
  );
  return rows.map((r) => String(r.error_code));
}

// ─── Circuit breaker config ───────────────────────────────────────────

export interface CircuitBreakerConfig {
  enabled: boolean;
  failureThresholdPct: number;
  windowMinutes: number;
  cooldownMinutes: number;
}

const DEFAULT_CB: CircuitBreakerConfig = {
  enabled: true,
  failureThresholdPct: 50,
  windowMinutes: 10,
  cooldownMinutes: 15,
};

export async function getCircuitBreakerConfig(pool: Pool): Promise<CircuitBreakerConfig> {
  const [enabledRaw, thresholdRaw, windowRaw, cooldownRaw] = await Promise.all([
    getSetting(pool, "cb_enabled"),
    getSetting(pool, "cb_failure_threshold"),
    getSetting(pool, "cb_window_minutes"),
    getSetting(pool, "cb_cooldown_minutes"),
  ]);
  return {
    enabled: enabledRaw === null ? DEFAULT_CB.enabled : enabledRaw === "1",
    failureThresholdPct:
      thresholdRaw === null
        ? DEFAULT_CB.failureThresholdPct
        : Math.min(100, Math.max(0, Number(thresholdRaw) || DEFAULT_CB.failureThresholdPct)),
    windowMinutes:
      windowRaw === null
        ? DEFAULT_CB.windowMinutes
        : Math.max(1, Number(windowRaw) || DEFAULT_CB.windowMinutes),
    cooldownMinutes:
      cooldownRaw === null
        ? DEFAULT_CB.cooldownMinutes
        : Math.max(1, Number(cooldownRaw) || DEFAULT_CB.cooldownMinutes),
  };
}

export interface CircuitBreakerUpdate {
  enabled?: boolean;
  failureThresholdPct?: number;
  windowMinutes?: number;
  cooldownMinutes?: number;
}

export async function setCircuitBreakerConfig(pool: Pool, patch: CircuitBreakerUpdate): Promise<void> {
  if (patch.enabled !== undefined) await setSetting(pool, "cb_enabled", patch.enabled ? "1" : "0");
  if (patch.failureThresholdPct !== undefined) {
    const clamped = Math.min(100, Math.max(0, Math.round(patch.failureThresholdPct)));
    await setSetting(pool, "cb_failure_threshold", String(clamped));
  }
  if (patch.windowMinutes !== undefined) {
    const clamped = Math.max(1, Math.round(patch.windowMinutes));
    await setSetting(pool, "cb_window_minutes", String(clamped));
  }
  if (patch.cooldownMinutes !== undefined) {
    const clamped = Math.max(1, Math.round(patch.cooldownMinutes));
    await setSetting(pool, "cb_cooldown_minutes", String(clamped));
  }
}

// ─── Provider health aggregates ───────────────────────────────────────
//
// Powers the "1h/24h/7d window stats" widget on the Providers tab.
// Reads from provider_call_counter (per-provider, per-UTC-day UPSERTed by
// touchProviderCalled in unknownIpBackfill). Returns one row per
// provider from the catalog so the UI doesn't need to handle "unknown
// provider" gaps.

export interface ProviderHealthWindow {
  providerName: string;
  windowMs: number;
  calls: number;
  errors429: number;
  errorsOther: number;
  failureRatePct: number;
  rateLimitedRatePct: number;
  lastCallAt: Date | null;
}

/** Aggregate call counts for ONE provider over a time window.
 *  - windowMs <= 24h: use last_called_at (precise to the second) so the
 *    1h window rolls cleanly across UTC-day boundaries.
 *  - windowMs > 24h: bucket by day_utc because daily UPSERTs are the
 *    smallest resolution the table natively carries. */
export async function aggregateProviderHealth(
  pool: Pool,
  name: string,
  windowMs: number,
): Promise<ProviderHealthWindow> {
  const args: unknown[] = [name];
  let callsCol: string;
  if (windowMs <= 24 * 60 * 60 * 1000) {
    // INTERVAL ? SECOND takes seconds, not milliseconds — the per-call
    // windowMs parameter is in ms (matches the public API of the
    // 1h/24h/7d widget).
    const seconds = Math.max(1, Math.ceil(windowMs / 1000));
    args.push(seconds);
    callsCol = `last_called_at >= (NOW(3) - INTERVAL ? SECOND)`;
  } else {
    const days = Math.max(1, Math.ceil(windowMs / (24 * 60 * 60 * 1000)));
    args.push(days);
    callsCol = `day_utc >= (CURDATE() - INTERVAL ? DAY)`;
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       COALESCE(SUM(calls_total), 0)        AS calls,
       COALESCE(SUM(calls_429), 0)          AS errors429,
       COALESCE(SUM(calls_timeout
                  + calls_network_err
                  + calls_other_err), 0)   AS errorsOther,
       MAX(last_called_at)                  AS lastCallAt
     FROM provider_call_counter
     WHERE provider_name = ? AND ${callsCol}`,
    args,
  );
  type AggRow = {
    calls: number | string | null;
    errors429: number | string | null;
    errorsOther: number | string | null;
    lastCallAt: Date | string | null;
  };
  const r = (rows[0] ?? {}) as AggRow;
  const calls = Number(r.calls ?? 0);
  const errors429 = Number(r.errors429 ?? 0);
  const errorsOther = Number(r.errorsOther ?? 0);
  const lastRaw = r.lastCallAt;
  return {
    providerName: name,
    windowMs,
    calls,
    errors429,
    errorsOther,
    failureRatePct: calls > 0 ? Math.round(((errors429 + errorsOther) / calls) * 1000) / 10 : 0,
    rateLimitedRatePct: calls > 0 ? Math.round((errors429 / calls) * 1000) / 10 : 0,
    lastCallAt: lastRaw ? new Date(lastRaw) : null,
  };
}

/** One ProviderHealthWindow per provider in PROVIDER_CATALOG. Providers
 *  with zero calls return 0s. */
export async function aggregateProviderHealthAll(
  pool: Pool,
  windowMs: number,
): Promise<ProviderHealthWindow[]> {
  const names = Object.keys(PROVIDER_CATALOG);
  // Run all providers concurrently — each query is ~10ms and there are
  // only 5 providers today. Parallel keeps the admin GET snappy.
  return Promise.all(names.map((n) => aggregateProviderHealth(pool, n, windowMs)));
}

// ─── 60s in-memory cache ──────────────────────────────────────────────
//
// aggregateProviderHealthAll hits MySQL every call. The Providers tab
// polls every 30s and the admin Overview page renders the same data —
// a 60s cache absorbs the burst without staleness risk for ops use.
// Mirrors the lastBackfillRunAt pattern (settings table) but for an
// expensive aggregate.

interface CacheEntry {
  at: number;
  data: ProviderHealthWindow[];
}

const HEALTH_CACHE_TTL_MS = 60_000;
const healthCache = new Map<number, CacheEntry>();

/** For tests: clear all cached health aggregates. */
export function _resetProviderHealthCache(): void {
  healthCache.clear();
}

export async function getAggregateProviderHealthAllCached(
  pool: Pool,
  windowMs: number,
): Promise<ProviderHealthWindow[]> {
  const now = Date.now();
  const cached = healthCache.get(windowMs);
  if (cached && now - cached.at < HEALTH_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await aggregateProviderHealthAll(pool, windowMs);
  healthCache.set(windowMs, { at: now, data });
  return data;
}

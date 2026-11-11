"use strict";
// SPDX-License-Identifier: MIT
//
// provider_error_log: per-failure audit trail for the IP-geolocation
// providers. Read by the /admin/unknown-ips "Failure Logs" tab; written
// by the backfill + random-gen flows (and by the circuit breaker when
// it auto-disables a provider). See migration 017.
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordProviderError = recordProviderError;
exports.queryProviderErrors = queryProviderErrors;
exports.distinctErrorCodes = distinctErrorCodes;
exports.getCircuitBreakerConfig = getCircuitBreakerConfig;
exports.setCircuitBreakerConfig = setCircuitBreakerConfig;
exports.aggregateProviderHealth = aggregateProviderHealth;
exports.aggregateProviderHealthAll = aggregateProviderHealthAll;
exports._resetProviderHealthCache = _resetProviderHealthCache;
exports.getAggregateProviderHealthAllCached = getAggregateProviderHealthAllCached;
const settings_1 = require("./settings");
const ingestProviders_1 = require("./ingestProviders");
function rowToError(r) {
    return {
        id: Number(r.id),
        providerName: String(r.provider_name),
        ipText: String(r.ip_text),
        mode: String(r.mode),
        errorCode: String(r.error_code),
        reason: String(r.reason),
        rawResponse: r.raw_response == null ? null : String(r.raw_response),
        ts: new Date(r.ts),
        retryCount: Number(r.retry_count),
    };
}
async function recordProviderError(pool, row) {
    await pool.query(`INSERT INTO provider_error_log
       (provider_name, ip_text, mode, error_code, reason, raw_response, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        row.providerName,
        row.ipText,
        row.mode,
        row.errorCode,
        row.reason.slice(0, 255),
        row.rawResponse ? row.rawResponse.slice(0, 512) : null,
        row.retryCount ?? 1,
    ]);
}
async function queryProviderErrors(pool, filter = {}) {
    const where = [];
    const args = [];
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
    const [rows] = await pool.query(sql, args);
    return rows.map(rowToError);
}
async function distinctErrorCodes(pool) {
    const [rows] = await pool.query(`SELECT DISTINCT error_code FROM provider_error_log
       WHERE ts >= (NOW() - INTERVAL 30 DAY)
       ORDER BY error_code`);
    return rows.map((r) => String(r.error_code));
}
const DEFAULT_CB = {
    enabled: true,
    failureThresholdPct: 50,
    windowMinutes: 10,
    cooldownMinutes: 15,
};
async function getCircuitBreakerConfig(pool) {
    const [enabledRaw, thresholdRaw, windowRaw, cooldownRaw] = await Promise.all([
        (0, settings_1.getSetting)(pool, "cb_enabled"),
        (0, settings_1.getSetting)(pool, "cb_failure_threshold"),
        (0, settings_1.getSetting)(pool, "cb_window_minutes"),
        (0, settings_1.getSetting)(pool, "cb_cooldown_minutes"),
    ]);
    return {
        enabled: enabledRaw === null ? DEFAULT_CB.enabled : enabledRaw === "1",
        failureThresholdPct: thresholdRaw === null
            ? DEFAULT_CB.failureThresholdPct
            : Math.min(100, Math.max(0, Number(thresholdRaw) || DEFAULT_CB.failureThresholdPct)),
        windowMinutes: windowRaw === null
            ? DEFAULT_CB.windowMinutes
            : Math.max(1, Number(windowRaw) || DEFAULT_CB.windowMinutes),
        cooldownMinutes: cooldownRaw === null
            ? DEFAULT_CB.cooldownMinutes
            : Math.max(1, Number(cooldownRaw) || DEFAULT_CB.cooldownMinutes),
    };
}
async function setCircuitBreakerConfig(pool, patch) {
    if (patch.enabled !== undefined)
        await (0, settings_1.setSetting)(pool, "cb_enabled", patch.enabled ? "1" : "0");
    if (patch.failureThresholdPct !== undefined) {
        const clamped = Math.min(100, Math.max(0, Math.round(patch.failureThresholdPct)));
        await (0, settings_1.setSetting)(pool, "cb_failure_threshold", String(clamped));
    }
    if (patch.windowMinutes !== undefined) {
        const clamped = Math.max(1, Math.round(patch.windowMinutes));
        await (0, settings_1.setSetting)(pool, "cb_window_minutes", String(clamped));
    }
    if (patch.cooldownMinutes !== undefined) {
        const clamped = Math.max(1, Math.round(patch.cooldownMinutes));
        await (0, settings_1.setSetting)(pool, "cb_cooldown_minutes", String(clamped));
    }
}
/** Aggregate call counts for ONE provider over a time window.
 *  - windowMs <= 24h: use last_called_at (precise to the second) so the
 *    1h window rolls cleanly across UTC-day boundaries.
 *  - windowMs > 24h: bucket by day_utc because daily UPSERTs are the
 *    smallest resolution the table natively carries. */
async function aggregateProviderHealth(pool, name, windowMs) {
    const args = [name];
    let callsCol;
    if (windowMs <= 24 * 60 * 60 * 1000) {
        // INTERVAL ? SECOND takes seconds, not milliseconds — the per-call
        // windowMs parameter is in ms (matches the public API of the
        // 1h/24h/7d widget).
        const seconds = Math.max(1, Math.ceil(windowMs / 1000));
        args.push(seconds);
        callsCol = `last_called_at >= (NOW(3) - INTERVAL ? SECOND)`;
    }
    else {
        const days = Math.max(1, Math.ceil(windowMs / (24 * 60 * 60 * 1000)));
        args.push(days);
        callsCol = `day_utc >= (CURDATE() - INTERVAL ? DAY)`;
    }
    const [rows] = await pool.query(`SELECT
       COALESCE(SUM(calls_total), 0)        AS calls,
       COALESCE(SUM(calls_429), 0)          AS errors429,
       COALESCE(SUM(calls_timeout
                  + calls_network_err
                  + calls_other_err), 0)   AS errorsOther,
       MAX(last_called_at)                  AS lastCallAt
     FROM provider_call_counter
     WHERE provider_name = ? AND ${callsCol}`, args);
    const r = (rows[0] ?? {});
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
async function aggregateProviderHealthAll(pool, windowMs) {
    const names = Object.keys(ingestProviders_1.PROVIDER_CATALOG);
    // Run all providers concurrently — each query is ~10ms and there are
    // only 5 providers today. Parallel keeps the admin GET snappy.
    return Promise.all(names.map((n) => aggregateProviderHealth(pool, n, windowMs)));
}
const HEALTH_CACHE_TTL_MS = 60_000;
const healthCache = new Map();
/** For tests: clear all cached health aggregates. */
function _resetProviderHealthCache() {
    healthCache.clear();
}
async function getAggregateProviderHealthAllCached(pool, windowMs) {
    const now = Date.now();
    const cached = healthCache.get(windowMs);
    if (cached && now - cached.at < HEALTH_CACHE_TTL_MS) {
        return cached.data;
    }
    const data = await aggregateProviderHealthAll(pool, windowMs);
    healthCache.set(windowMs, { at: now, data });
    return data;
}
//# sourceMappingURL=providerErrorLog.js.map
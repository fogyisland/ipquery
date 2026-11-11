"use strict";
// SPDX-License-Identifier: MIT
//
// Admin-tunable configuration for the IP-geolocation providers that
// /admin/unknown-ips backfill fans out to. Lives in MySQL so the admin
// can toggle a provider on/off and rotate its key from the UI without
// a server restart.
//
// The provider CATALOG below is the source of truth for which providers
// the system CAN use. The DB holds the runtime toggle + key. To add a
// new provider:
//   1. Add a class in src/etl/providers/<name>.ts implementing
//      IpGeoProvider.
//   2. Add an entry to PROVIDER_CATALOG.
//   3. Add an INSERT to migration 016_ingest_providers.sql.
//   4. Wire buildProvidersFromConfig() to map the catalog entry to the
//      provider class with the configured api_key.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROVIDER_CATALOG_LIST = exports.PROVIDER_CATALOG = void 0;
exports.listProviderConfigs = listProviderConfigs;
exports.getProviderConfig = getProviderConfig;
exports.upsertCustomProvider = upsertCustomProvider;
exports.deleteCustomProvider = deleteCustomProvider;
exports.updateProviderConfig = updateProviderConfig;
exports.touchProviderSuccess = touchProviderSuccess;
exports.touchProviderError = touchProviderError;
exports.touchProviderCalled = touchProviderCalled;
exports.buildProvidersFromConfig = buildProvidersFromConfig;
exports.saveLastBackfillProviderStats = saveLastBackfillProviderStats;
exports.loadLastBackfillProviderStats = loadLastBackfillProviderStats;
const settings_1 = require("./settings");
const ipApi_1 = require("../etl/providers/ipApi");
const ipinfo_1 = require("../etl/providers/ipinfo");
const iplocate_1 = require("../etl/providers/iplocate");
const freeipapi_1 = require("../etl/providers/freeipapi");
const ipapiCo_1 = require("../etl/providers/ipapiCo");
const genericHttpProvider_1 = require("../etl/genericHttpProvider");
/** Static catalog. Mirrors the seeded rows in migration 016 — adding a
 *  new provider requires a row AND a catalog entry, never one alone.
 *  Exported (not just a module-private const) so peers like
 *  providerErrorLog can iterate the provider names without re-typing
 *  them. */
exports.PROVIDER_CATALOG = {
    "ip-api": { displayName: "IP-API", freeQuota: "45 req/min, no key (HTTP only)" },
    iplocate: { displayName: "IPLocate.io", freeQuota: "1,000 req/day, key required (HTTPS)" },
    ipinfo: { displayName: "IPinfo.io", freeQuota: "50,000 req/month, key required (HTTPS)" },
    freeipapi: { displayName: "FreeIPAPI", freeQuota: "60 req/min, no key (HTTPS)" },
    "ipapi-co": { displayName: "ipapi.co", freeQuota: "30,000 req/month, no key (HTTPS)" },
};
exports.PROVIDER_CATALOG_LIST = Object.entries(exports.PROVIDER_CATALOG).map(([name, meta]) => ({
    name,
    displayName: meta.displayName,
    freeQuota: meta.freeQuota,
    enabled: true,
    apiKey: null,
    rateLimitPerMin: null,
    lastUsedAt: null,
    lastErrorAt: null,
    lastErrorReason: null,
    autoReenableAt: null,
    autoDisabledReason: null,
    isCustom: false,
    customUrlTemplate: null,
    customMethod: "GET",
    customRequestBody: null,
    customResponseFormat: "json",
    customCountryPath: null,
    customCityPath: null,
    customAsnPath: null,
    customTimeoutMs: null,
}));
async function listProviderConfigs(pool) {
    const [rows] = await pool.query(`SELECT name, display_name, free_quota, enabled, api_key,
            rate_limit_per_min, last_used_at, last_error_at, last_error_reason,
            auto_reenable_at, auto_disabled_reason,
            is_custom, custom_url_template, custom_method, custom_request_body,
            custom_response_format, custom_country_path, custom_city_path,
            custom_asn_path, custom_timeout_ms
       FROM ingest_providers
       ORDER BY name`);
    return rows.map(rowToConfig);
}
function rowToConfig(r) {
    return {
        name: String(r.name),
        displayName: String(r.display_name),
        freeQuota: String(r.free_quota),
        enabled: Boolean(r.enabled),
        apiKey: r.api_key == null ? null : String(r.api_key),
        rateLimitPerMin: r.rate_limit_per_min == null ? null : Number(r.rate_limit_per_min),
        lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
        lastErrorAt: r.last_error_at ? new Date(r.last_error_at) : null,
        lastErrorReason: r.last_error_reason == null ? null : String(r.last_error_reason),
        autoReenableAt: r.auto_reenable_at ? new Date(r.auto_reenable_at) : null,
        autoDisabledReason: r.auto_disabled_reason == null ? null : String(r.auto_disabled_reason),
        isCustom: Boolean(r.is_custom),
        customUrlTemplate: r.custom_url_template == null ? null : String(r.custom_url_template),
        customMethod: r.custom_method === "POST" ? "POST" : "GET",
        customRequestBody: r.custom_request_body == null ? null : String(r.custom_request_body),
        customResponseFormat: r.custom_response_format === "text" ? "text" : "json",
        customCountryPath: r.custom_country_path == null ? null : String(r.custom_country_path),
        customCityPath: r.custom_city_path == null ? null : String(r.custom_city_path),
        customAsnPath: r.custom_asn_path == null ? null : String(r.custom_asn_path),
        customTimeoutMs: r.custom_timeout_ms == null ? null : Number(r.custom_timeout_ms),
    };
}
async function getProviderConfig(pool, name) {
    const [rows] = await pool.query(`SELECT name, display_name, free_quota, enabled, api_key,
            rate_limit_per_min, last_used_at, last_error_at, last_error_reason,
            auto_reenable_at, auto_disabled_reason,
            is_custom, custom_url_template, custom_method, custom_request_body,
            custom_response_format, custom_country_path, custom_city_path,
            custom_asn_path, custom_timeout_ms
       FROM ingest_providers WHERE name = ? LIMIT 1`, [name]);
    if (rows.length === 0)
        return null;
    const r = rows[0];
    if (!r)
        return null;
    return rowToConfig(r);
}
/** Upsert a custom provider. INSERT … ON DUPLICATE KEY UPDATE keeps the
 *  path simple: first create writes a new row (is_custom=1), subsequent
 *  updates refresh the custom_* columns in place. The api_key column is
 *  NOT touched here — it's rotated through updateProviderConfig like
 *  the built-in providers. */
async function upsertCustomProvider(pool, name, f) {
    await pool.query(`INSERT INTO ingest_providers
       (name, display_name, free_quota, enabled, api_key,
        is_custom, custom_url_template, custom_method, custom_request_body,
        custom_response_format, custom_country_path, custom_city_path,
        custom_asn_path, custom_timeout_ms)
     VALUES (?, ?, '', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       display_name          = VALUES(display_name),
       enabled               = VALUES(enabled),
       api_key               = VALUES(api_key),
       custom_url_template   = VALUES(custom_url_template),
       custom_method         = VALUES(custom_method),
       custom_request_body   = VALUES(custom_request_body),
       custom_response_format= VALUES(custom_response_format),
       custom_country_path   = VALUES(custom_country_path),
       custom_city_path      = VALUES(custom_city_path),
       custom_asn_path       = VALUES(custom_asn_path),
       custom_timeout_ms     = VALUES(custom_timeout_ms)`, [
        name,
        f.displayName,
        f.enabled === false ? 0 : 1,
        f.apiKey && f.apiKey.length > 0 ? f.apiKey : null,
        f.urlTemplate,
        f.method,
        f.requestBody,
        f.responseFormat,
        f.countryPath,
        f.cityPath,
        f.asnPath,
        f.timeoutMs,
    ]);
}
/** Delete a custom provider. The is_custom=1 guard means a typo in the
 *  URL path can never accidentally drop a built-in row. Returns the
 *  number of rows actually deleted (0 when name didn't exist or was a
 *  built-in). */
async function deleteCustomProvider(pool, name) {
    const [res] = await pool.query(`DELETE FROM ingest_providers WHERE name = ? AND is_custom = 1`, [name]);
    return res.affectedRows;
}
async function updateProviderConfig(pool, name, patch) {
    const sets = [];
    const args = [];
    if (patch.enabled !== undefined) {
        sets.push("enabled = ?");
        args.push(patch.enabled ? 1 : 0);
    }
    if (patch.apiKey !== undefined) {
        sets.push("api_key = ?");
        args.push(patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : null);
    }
    if (patch.autoReenableAt !== undefined) {
        sets.push("auto_reenable_at = ?");
        args.push(patch.autoReenableAt);
    }
    if (patch.autoDisabledReason !== undefined) {
        sets.push("auto_disabled_reason = ?");
        args.push(patch.autoDisabledReason && patch.autoDisabledReason.length > 0
            ? patch.autoDisabledReason.slice(0, 255)
            : null);
    }
    if (sets.length === 0)
        return;
    args.push(name);
    await pool.query(`UPDATE ingest_providers SET ${sets.join(", ")} WHERE name = ?`, args);
}
async function touchProviderSuccess(pool, name) {
    await pool.query(`UPDATE ingest_providers SET last_used_at = CURRENT_TIMESTAMP(3), last_error_reason = NULL
     WHERE name = ?`, [name]);
}
async function touchProviderError(pool, name, reason) {
    await pool.query(`UPDATE ingest_providers SET last_error_at = CURRENT_TIMESTAMP(3), last_error_reason = ?
     WHERE name = ?`, [reason.slice(0, 255), name]);
}
/** Per-provider, per-UTC-day call counter. UPSERTs into provider_call_counter
 *  so calls within the same UTC day accumulate into one row. Called from
 *  processIp() in unknownIpBackfill AFTER every provider.lookup() —
 *  successful, rate-limited, errored, or thrown. Powers the "1h/24h/7d
 *  window stats" widget on the Providers tab and the "daily quota usage"
 *  pill.
 *
 *  All bucketing happens in JS — we bind only 0/1 increments so MySQL
 *  never has to coerce a string errorCode against numeric/equality
 *  literals in WHERE-style comparison contexts (which would error with
 *  "Truncated incorrect DOUBLE value: 'timeout'"). 9 placeholders
 *  total: 1 (name) + 4 (buckets for VALUES) + 4 (buckets for UPDATE). */
async function touchProviderCalled(pool, name, outcome) {
    const rateLimited = outcome.rateLimited === true;
    const errorCode = outcome.errorCode ?? null;
    const is429 = rateLimited ? 1 : 0;
    const isTimeout = errorCode === "timeout" ? 1 : 0;
    const isNetwork = errorCode === "network" ? 1 : 0;
    // "other" = had an errorCode but it wasn't 429/timeout/network — e.g.
    // 'http_500', 'no_country', 'unauthorized'.
    const isOther = !rateLimited && errorCode != null && errorCode !== "timeout" && errorCode !== "network" ? 1 : 0;
    await pool.query(`INSERT INTO provider_call_counter
       (provider_name, day_utc, calls_total, calls_429, calls_timeout,
        calls_network_err, calls_other_err, last_called_at)
     VALUES (?, UTC_DATE(), 1, ?, ?, ?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE
       calls_total        = calls_total + 1,
       calls_429          = calls_429 + ?,
       calls_timeout      = calls_timeout + ?,
       calls_network_err  = calls_network_err + ?,
       calls_other_err    = calls_other_err + ?,
       last_called_at     = NOW(3)`, [
        // INSERT VALUES (5 placeholders):
        name,
        is429,
        isTimeout,
        isNetwork,
        isOther,
        // ON DUPLICATE KEY UPDATE (4 placeholders, in order):
        is429,
        isTimeout,
        isNetwork,
        isOther,
    ]);
    // Mirror the call into the per-minute table. The daily table cannot
    // express a circuit-breaker window shorter than a day, so the
    // breaker reads this one for sub-day windows (see
    // countProviderCallsInWindow in src/etl/unknownIpBackfill.ts).
    //
    // Best-effort by design: on a database that predates migration 024
    // the table does not exist, and the daily counter above has already
    // recorded the call. Failing here would lose that call AND abort the
    // caller, so we log and move on — the only consequence is that the
    // breaker keeps day granularity until the migration is applied.
    try {
        await pool.query(`INSERT INTO provider_call_counter_minute
         (provider_name, minute_utc, calls_total, calls_429, calls_timeout,
          calls_network_err, calls_other_err)
       VALUES (?, DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:00'), 1, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         calls_total        = calls_total + 1,
         calls_429          = calls_429 + ?,
         calls_timeout      = calls_timeout + ?,
         calls_network_err  = calls_network_err + ?,
         calls_other_err    = calls_other_err + ?`, [
            // INSERT VALUES (5 placeholders):
            name,
            is429,
            isTimeout,
            isNetwork,
            isOther,
            // ON DUPLICATE KEY UPDATE (4 placeholders, in order):
            is429,
            isTimeout,
            isNetwork,
            isOther,
        ]);
    }
    catch (err) {
        console.warn(`[providers] minute counter write failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/** Build provider instances for the backfill job, reading enabled
 *  + api_key from the DB. Disabled providers are skipped entirely.
 *  Custom providers (is_custom=1) are dispatched to GenericHttpProvider
 *  with their DB-stored template + field paths. */
function buildProvidersFromConfig(configs) {
    const out = [];
    for (const c of configs) {
        if (!c.enabled)
            continue;
        // Custom providers always dispatch to GenericHttpProvider regardless
        // of `name` — the catalog switch below only matches the 5 hard-coded
        // providers, so anything else (including a custom row with a name
        // that happens to collide with a built-in) goes through the generic
        // path. URL + field mapping must be present; otherwise we skip.
        if (c.isCustom) {
            if (!c.customUrlTemplate || !c.customCountryPath) {
                // eslint-disable-next-line no-console
                console.warn?.(`[ingestProviders] custom provider ${c.name} missing url_template or country_path; skipping`);
                continue;
            }
            const row = {
                name: c.name,
                urlTemplate: c.customUrlTemplate,
                method: c.customMethod,
                requestBody: c.customRequestBody,
                responseFormat: c.customResponseFormat,
                countryPath: c.customCountryPath,
                cityPath: c.customCityPath,
                asnPath: c.customAsnPath,
                timeoutMs: c.customTimeoutMs,
                apiKey: c.apiKey,
            };
            out.push(new genericHttpProvider_1.GenericHttpProvider(row));
            continue;
        }
        switch (c.name) {
            case "ip-api":
                out.push(new ipApi_1.IpApiProvider());
                break;
            case "iplocate":
                // Provider abstains on its own if apiKey is null — but skipping
                // here avoids the per-call null check.
                if (c.apiKey)
                    out.push(new iplocate_1.IplocateProvider({ apiKey: c.apiKey }));
                break;
            case "ipinfo":
                if (c.apiKey)
                    out.push(new ipinfo_1.IpinfoProvider({ token: c.apiKey }));
                break;
            case "freeipapi":
                out.push(new freeipapi_1.FreeIpApiProvider());
                break;
            case "ipapi-co":
                out.push(new ipapiCo_1.IpapiCoProvider());
                break;
            default:
                // Unknown name — log via warn, don't fail the whole job.
                // eslint-disable-next-line no-console
                console.warn?.(`[ingestProviders] unknown provider name: ${c.name}`);
        }
    }
    return out;
}
// ─── Last-backfill per-provider aggregate ─────────────────────────────────
//
// BackfillSummary.providers only lives in memory until the POST handler
// serializes it to the backfill_summary flash cookie (which is gone after
// one refresh). Persist the latest run's per-provider counts to settings
// so the unknown-ips dashboard can show "this provider failed N times in
// the last run" across sessions — without a DB migration.
const LAST_BACKFILL_KEY = "last_backfill_provider_stats";
async function saveLastBackfillProviderStats(pool, providers, runAt) {
    const env = {
        runAt: runAt.toISOString(),
        providers,
    };
    await (0, settings_1.setSetting)(pool, LAST_BACKFILL_KEY, JSON.stringify(env));
}
async function loadLastBackfillProviderStats(pool) {
    const raw = await (0, settings_1.getSetting)(pool, LAST_BACKFILL_KEY);
    if (!raw)
        return { runAt: null, providers: {} };
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || !parsed.providers) {
            return { runAt: null, providers: {} };
        }
        return {
            runAt: parsed.runAt ? new Date(parsed.runAt) : null,
            providers: parsed.providers,
        };
    }
    catch {
        return { runAt: null, providers: {} };
    }
}
//# sourceMappingURL=ingestProviders.js.map
"use strict";
// SPDX-License-Identifier: MIT
//
// random_probe_log: per-IP audit trail for the API ingest flows
// (runBackfill, runRandomGeneration, manual-generate). Read by the
// /admin/unknown-ips Overview tab "Recent Probes" table; written by the
// call sites of processIp via recordRandomProbe(). See migration 018.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_RETENTION_DAYS = void 0;
exports.recordRandomProbe = recordRandomProbe;
exports.recentProbes = recentProbes;
exports.probeSummaryStats = probeSummaryStats;
exports.loadRandomGenConfig = loadRandomGenConfig;
exports.saveRandomGenConfig = saveRandomGenConfig;
exports.loadRetentionDays = loadRetentionDays;
exports.purgeOldProbes = purgeOldProbes;
exports.saveRetentionDays = saveRetentionDays;
const settings_1 = require("./settings");
function rowToProbe(r) {
    let providers = [];
    if (r.providers_json) {
        try {
            const parsed = JSON.parse(String(r.providers_json));
            if (Array.isArray(parsed))
                providers = parsed;
        }
        catch {
            /* malformed JSON → empty array, surface the row anyway */
        }
    }
    return {
        id: Number(r.id),
        ipText: String(r.ip_text),
        mode: String(r.mode),
        outcome: String(r.outcome),
        consensusCountry: r.consensus_country == null ? null : String(r.consensus_country),
        consensusCity: r.consensus_city == null ? null : String(r.consensus_city),
        consensusAsn: r.consensus_asn == null ? null : Number(r.consensus_asn),
        mergedRunId: r.merged_run_id == null ? null : Number(r.merged_run_id),
        providers,
        batchId: r.batch_id == null ? null : String(r.batch_id),
        ts: new Date(r.ts),
    };
}
async function recordRandomProbe(pool, row) {
    await pool.query(`INSERT INTO random_probe_log
       (ip_text, ip_binary, mode, outcome, consensus_country, consensus_city,
        consensus_asn, merged_run_id, providers_json, batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        row.ipText,
        row.ipBinary,
        row.mode,
        row.outcome,
        row.consensusCountry,
        row.consensusCity,
        row.consensusAsn,
        row.mergedRunId,
        JSON.stringify(row.providers),
        row.batchId,
    ]);
}
async function recentProbes(pool, filter = {}) {
    const whereArr = [];
    const args = [];
    if (filter.mode) {
        whereArr.push("mode = ?");
        args.push(filter.mode);
    }
    if (filter.outcome) {
        whereArr.push("outcome = ?");
        args.push(filter.outcome);
    }
    const limit = Math.min(filter.limit ?? 20, 100);
    const sql = `SELECT id, ip_text, mode, outcome, consensus_country, consensus_city,
                      consensus_asn, merged_run_id, providers_json, batch_id, ts
                 FROM random_probe_log
                ${whereArr.length ? "WHERE " + whereArr.join(" AND ") : ""}
                ORDER BY ts DESC, id DESC
                LIMIT ${limit}`;
    const [rows] = await pool.query(sql, args);
    return rows.map(rowToProbe);
}
/** Compute summary stats over the trailing `windowMs` window (default
 *  1h). Walks providers_json for each row to attribute per-provider
 *  counters. Volume assumption: a 1h window returns at most a few
 *  hundred rows (well below the ~70k/day cap), so the in-process
 *  aggregation is cheap. */
async function probeSummaryStats(pool, windowMs = 60 * 60 * 1000) {
    const sinceMs = Date.now() - windowMs;
    const [rows] = await pool.query(`SELECT outcome, providers_json
       FROM random_probe_log
      WHERE ts >= FROM_UNIXTIME(? / 1000)`, [sinceMs]);
    const stats = {
        total: rows.length,
        merged: 0,
        noConsensus: 0,
        noCountry: 0,
        allAbstained: 0,
        successRatePct: 0,
        warmingRatePerDay: 0,
        byProvider: {},
    };
    for (const r of rows) {
        const outcome = String(r.outcome);
        if (outcome === "merged")
            stats.merged += 1;
        else if (outcome === "no_consensus")
            stats.noConsensus += 1;
        else if (outcome === "no_country")
            stats.noCountry += 1;
        else if (outcome === "all_abstained")
            stats.allAbstained += 1;
        let providers = [];
        if (r.providers_json) {
            try {
                const parsed = JSON.parse(String(r.providers_json));
                if (Array.isArray(parsed))
                    providers = parsed;
            }
            catch {
                /* skip */
            }
        }
        for (const pp of providers) {
            const slot = stats.byProvider[pp.provider] ?? {
                ok: 0,
                rateLimited: 0,
                timeout: 0,
                noCountry: 0,
                error: 0,
            };
            if (pp.rateLimited)
                slot.rateLimited += 1;
            else if (pp.errorCode === "timeout")
                slot.timeout += 1;
            else if (pp.errorCode === "no_country")
                slot.noCountry += 1;
            else if (pp.errorCode)
                slot.error += 1;
            else
                slot.ok += 1;
            stats.byProvider[pp.provider] = slot;
        }
    }
    stats.successRatePct = stats.total > 0 ? Math.round((stats.merged / stats.total) * 100) : 0;
    // Project window rate to 24h. Rounded to 1 decimal for the UI.
    const hours = windowMs / (60 * 60 * 1000);
    stats.warmingRatePerDay = hours > 0 ? Math.round((stats.total / hours) * 24) : 0;
    return stats;
}
const DEFAULT_CONFIG = {
    intervalSec: 60,
    batchSize: 10,
    cooldownMinutes: 15,
    cbLinkage: true,
};
async function loadRandomGenConfig(pool) {
    const [intervalRaw, batchRaw, cooldownRaw, cbRaw] = await Promise.all([
        (0, settings_1.getSetting)(pool, "random_gen_interval_sec"),
        (0, settings_1.getSetting)(pool, "random_gen_batch_size"),
        (0, settings_1.getSetting)(pool, "random_gen_cooldown_minutes"),
        (0, settings_1.getSetting)(pool, "random_gen_cb_linkage"),
    ]);
    return {
        intervalSec: intervalRaw === null
            ? DEFAULT_CONFIG.intervalSec
            : Math.min(3600, Math.max(1, Number(intervalRaw) || DEFAULT_CONFIG.intervalSec)),
        batchSize: batchRaw === null
            ? DEFAULT_CONFIG.batchSize
            : Math.min(100, Math.max(1, Number(batchRaw) || DEFAULT_CONFIG.batchSize)),
        cooldownMinutes: cooldownRaw === null
            ? DEFAULT_CONFIG.cooldownMinutes
            : Math.min(1440, Math.max(0, Number(cooldownRaw) || DEFAULT_CONFIG.cooldownMinutes)),
        cbLinkage: cbRaw === null ? DEFAULT_CONFIG.cbLinkage : cbRaw === "1",
    };
}
async function saveRandomGenConfig(pool, patch) {
    if (patch.intervalSec !== undefined) {
        const clamped = Math.min(3600, Math.max(1, Math.round(patch.intervalSec)));
        await (0, settings_1.setSetting)(pool, "random_gen_interval_sec", String(clamped));
    }
    if (patch.batchSize !== undefined) {
        const clamped = Math.min(100, Math.max(1, Math.round(patch.batchSize)));
        await (0, settings_1.setSetting)(pool, "random_gen_batch_size", String(clamped));
    }
    if (patch.cooldownMinutes !== undefined) {
        const clamped = Math.min(1440, Math.max(0, Math.round(patch.cooldownMinutes)));
        await (0, settings_1.setSetting)(pool, "random_gen_cooldown_minutes", String(clamped));
    }
    if (patch.cbLinkage !== undefined) {
        await (0, settings_1.setSetting)(pool, "random_gen_cb_linkage", patch.cbLinkage ? "1" : "0");
    }
}
// ─── Retention ─────────────────────────────────────────────────────────
//
// random_probe_log grows ~20k rows/day at worst case (see migration 018's
// volume note). Without a sweep the table grows unbounded — at 20k/day
// that's 7.3M rows/year, and the table stores a providers_json blob per
// row, so it grows faster than the row count suggests.
//
// The sweep keeps a trailing window (default 30 days) and deletes
// anything older. It is a single indexed DELETE by ts — the table has a
// ts index (migration 018) so this stays cheap even at millions of rows.
//
// The window is configurable via the `random_probe_retention_days`
// setting so an operator with a compliance requirement to keep probe
// history longer can raise it without a code change. A value of 0 means
// "keep forever" and disables the sweep.
exports.DEFAULT_RETENTION_DAYS = 30;
async function loadRetentionDays(pool) {
    const raw = await (0, settings_1.getSetting)(pool, "random_probe_retention_days");
    if (raw === null)
        return exports.DEFAULT_RETENTION_DAYS;
    const days = Number(raw);
    if (!Number.isFinite(days) || days < 0)
        return exports.DEFAULT_RETENTION_DAYS;
    return Math.floor(days);
}
/** Delete probe rows older than `retentionDays`. Returns the number of
 *  rows removed. `retentionDays <= 0` means "keep forever" and is a
 *  no-op returning 0. */
async function purgeOldProbes(pool, retentionDays) {
    if (retentionDays <= 0)
        return 0;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const [result] = await pool.query(`DELETE FROM random_probe_log WHERE ts < FROM_UNIXTIME(? / 1000)`, [cutoffMs]);
    return result.affectedRows;
}
/** Persist the retention window. Clamped to 0..3650 days — 0 means
 *  "keep forever" (the sweep is disabled), 3650 = 10 years. */
async function saveRetentionDays(pool, days) {
    const clamped = Math.min(3650, Math.max(0, Math.round(days)));
    await (0, settings_1.setSetting)(pool, "random_probe_retention_days", String(clamped));
}
//# sourceMappingURL=randomProbeLog.js.map
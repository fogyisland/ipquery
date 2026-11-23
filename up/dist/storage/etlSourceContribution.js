"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRunSourceReport = buildRunSourceReport;
// SPDX-License-Identifier: MIT
//
// Per-source ETL contribution for one run.
//
// WHY THIS EXISTS
//
// The run row (`etl_runs`) carries one lumped counter for the whole
// DB-IP family and nothing for the other six files. The per-file
// numbers live in the stage tables — `etl_run_downloads` for what was
// fetched, `etl_run_parses` for what each file yielded, `etl_run_inserts`
// for what each file put into the table.
//
// The admin run-detail page reads those tables directly. The MCP server
// could not: `ipquery_etl_status` reported a `sources` map whose only
// non-null counter was `dbip`. An operator asking an AI client "which
// source gave me the Chinese ranges?" had no way to find out.
//
// The shape
// ---------
//
// One entry per source, keyed by the ETL source label (`dbip-city`,
// `runishiwo-cn`, …). The three stage tables are joined in memory
// rather than in SQL because they have no common key beyond
// (run_id, source) and the row counts are tiny — seven sources, three
// tables.
//
// A source with no row in a given table is **absent** from that
// facet, not zero. "No parse row" and "parsed zero rows" are
// different facts, and reporting the second would be a claim the
// table does not make.
const mysql_1 = require("./mysql");
const labels_1 = require("../etl/sources/labels");
/** Every skip reason a parse row counts, summed into one number. */
function totalSkipped(parse) {
    return (parse.rowsSkippedShort +
        parse.rowsSkippedHeader +
        parse.rowsSkippedUnparseableIp +
        parse.rowsSkippedMissingCol +
        parse.rowsSkippedNanAsn +
        parse.rowsSkippedOther);
}
/**
 * The per-source contribution of one ETL run.
 *
 * `runId` selects the run; when it is null the most recent run is
 * used. A run with no stage rows at all — a run that failed before
 * the first file landed — yields an empty source list, not a list of
 * zeros.
 */
async function buildRunSourceReport(pool, runId) {
    // Resolve the run first: the stage tables are keyed by run_id, and a
    // null run_id would match nothing without saying why.
    let targetRunId = runId;
    if (targetRunId === null) {
        const [rows] = await pool.query(`SELECT id FROM etl_runs ORDER BY id DESC LIMIT 1`);
        const latest = rows[0];
        if (!latest)
            return { runId: null, sources: [] };
        targetRunId = Number(latest.id);
    }
    const [downloads, parses, inserts] = await Promise.all([
        (0, mysql_1.listEtlRunDownloads)(pool, targetRunId),
        (0, mysql_1.listEtlRunParses)(pool, targetRunId),
        (0, mysql_1.listEtlRunInserts)(pool, targetRunId),
    ]);
    const labels = (0, labels_1.etlSourceLabelMap)();
    const key = (source, destName) => `${source}\u0000${destName}`;
    const merged = new Map();
    const ensure = (source, destName) => {
        const id = key(source, destName);
        let entry = merged.get(id);
        if (!entry) {
            entry = {
                source,
                label: labels[source] ?? source,
                downloadStatus: null,
                bytes: null,
                rowsEmitted: null,
                rowsSkipped: null,
                rowsAttempted: null,
                rowsInserted: null,
                rowsDuplicates: null,
                insertDurationMs: null,
                parseDurationMs: null,
            };
            merged.set(id, entry);
        }
        return entry;
    };
    for (const download of downloads) {
        const entry = ensure(download.source, download.destName);
        entry.downloadStatus = download.status;
        entry.bytes = download.bytes ?? null;
    }
    for (const parse of parses) {
        const entry = ensure(parse.source, parse.destName);
        entry.rowsEmitted = parse.rowsEmitted;
        entry.rowsSkipped = totalSkipped(parse);
        entry.parseDurationMs = parse.durationMs;
    }
    for (const insert of inserts) {
        const entry = ensure(insert.source, insert.destName);
        entry.rowsAttempted = insert.rowsAttempted;
        entry.rowsInserted = insert.rowsInserted;
        entry.rowsDuplicates = insert.rowsDuplicates;
        entry.insertDurationMs = insert.durationMs;
    }
    return { runId: targetRunId, sources: [...merged.values()] };
}
//# sourceMappingURL=etlSourceContribution.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ETL_SOURCE_LABELS = void 0;
exports.etlSourceLabels = etlSourceLabels;
exports.etlSourceLabelMap = etlSourceLabelMap;
exports.etlUpstreamCount = etlUpstreamCount;
/**
 * The sources the ETL pipeline runs.
 *
 * The list is the pipeline's own table, imported from pipeline.ts.
 * pipeline.ts does not import this module, so there is no cycle.
 */
exports.ETL_SOURCE_LABELS = {
    "dbip-city": { key: "dbip-city", label: "DB-IP City", hasRunCounter: false },
    "dbip-country": { key: "dbip-country", label: "DB-IP Country", hasRunCounter: false },
    "dbip-asn": { key: "dbip-asn", label: "DB-IP ASN", hasRunCounter: false },
    "metowolf-cn": { key: "metowolf-cn", label: "metowolf/iplist (CN)", hasRunCounter: false },
    "runishiwo-cn": { key: "runishiwo-cn", label: "runishiwo/ChinaIPlist (CN v4)", hasRunCounter: false },
    "runishiwo-v6": { key: "runishiwo-v6", label: "runishiwo/ChinaIPlist (CN v6)", hasRunCounter: false },
    "sapics-user": { key: "sapics-user", label: "sapics/ip-location-db (user country)", hasRunCounter: false },
};
/**
 * The source list, in the order the pipeline runs them — which is the
 * order the files are fetched and the rows are filled, so it is also
 * the priority order.
 */
function etlSourceLabels() {
    return Object.values(exports.ETL_SOURCE_LABELS);
}
/**
 * The labels as a plain object, for a caller that wants to look a
 * source up rather than list them.
 */
function etlSourceLabelMap() {
    const out = {};
    for (const label of etlSourceLabels())
        out[label.key] = label.label;
    return out;
}
/**
 * How many distinct upstreams the pipeline draws from.
 *
 * The pipeline fetches seven files, but those files come from four
 * places: DB-IP (three files), metowolf/iplist, runishiwo/ChinaIPlist
 * (two files) and sapics/ip-location-db. A page that says "N data
 * sources" means upstreams, not files — "seven data sources" would
 * read as seven independent providers, which is not what a second file
 * from the same repository is.
 *
 * Derived from the label table so it cannot drift from the pipeline
 * the way a hand-written number does.
 */
function etlUpstreamCount() {
    const upstreams = new Set();
    for (const label of etlSourceLabels()) {
        if (label.key.startsWith("dbip-"))
            upstreams.add("dbip");
        else if (label.key === "runishiwo-cn" || label.key === "runishiwo-v6") {
            upstreams.add("runishiwo");
        }
        else
            upstreams.add(label.key);
    }
    return upstreams.size;
}
//# sourceMappingURL=labels.js.map
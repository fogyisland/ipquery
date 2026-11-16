"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEDUPE_CONFLICT_PRIORITY = exports.DEDUPE_MAX_INPUT_ROWS = void 0;
exports.dedupeSourceRecords = dedupeSourceRecords;
// SPDX-License-Identifier: MIT
const ip_1 = require("../../ip");
exports.DEDUPE_MAX_INPUT_ROWS = 1_000_000;
exports.DEDUPE_CONFLICT_PRIORITY = {
    "sapics-user": 3,
    "runishiwo-cn": 2,
    "metowolf-cn": 1,
};
function priorityFor(source) {
    return exports.DEDUPE_CONFLICT_PRIORITY[source] ?? 0;
}
function sameRange(first, second) {
    return ((0, ip_1.compareBuffers)(first.startIp, second.startIp) === 0 &&
        (0, ip_1.compareBuffers)(first.endIp, second.endIp) === 0);
}
function contains(outer, inner) {
    return ((0, ip_1.compareBuffers)(outer.startIp, inner.startIp) <= 0 &&
        (0, ip_1.compareBuffers)(outer.endIp, inner.endIp) >= 0);
}
function sortByLargerRangeFirst(records) {
    records.sort((left, right) => {
        const byStart = (0, ip_1.compareBuffers)(left.startIp, right.startIp);
        return byStart !== 0 ? byStart : (0, ip_1.compareBuffers)(right.endIp, left.endIp);
    });
}
function incrementByFile(stats, record, delta) {
    const current = stats.emittedByFile[record.etlSource] ?? 0;
    const next = current + delta;
    if (next === 0) {
        delete stats.emittedByFile[record.etlSource];
    }
    else {
        stats.emittedByFile[record.etlSource] = next;
    }
}
function replaceWithHigherPriority(records, active, stats, existingIndex, candidate) {
    const previous = records[existingIndex];
    if (priorityFor(candidate.source) <= priorityFor(previous.source))
        return;
    incrementByFile(stats, previous, -1);
    records[existingIndex] = candidate;
    incrementByFile(stats, candidate, 1);
    for (const item of active) {
        if (item.outputIndex === existingIndex)
            item.record = candidate;
    }
}
function dedupeFamily(familyRecords, records, stats) {
    sortByLargerRangeFirst(familyRecords);
    const active = [];
    for (const candidate of familyRecords) {
        active.splice(0, active.length, ...active.filter((item) => (0, ip_1.compareBuffers)(item.record.endIp, candidate.startIp) >= 0));
        let coveredBy = null;
        let exact = null;
        let overlaps = false;
        for (const item of active) {
            if (sameRange(item.record, candidate)) {
                exact = item;
                break;
            }
            if (contains(item.record, candidate)) {
                coveredBy = item;
                break;
            }
            if ((0, ip_1.compareBuffers)(item.record.endIp, candidate.startIp) >= 0 &&
                (0, ip_1.compareBuffers)(item.record.endIp, candidate.endIp) < 0) {
                overlaps = true;
            }
        }
        if (exact) {
            stats.exactDuplicates += 1;
            replaceWithHigherPriority(records, active, stats, exact.outputIndex, candidate);
            continue;
        }
        if (coveredBy) {
            stats.contained += 1;
            continue;
        }
        if (overlaps)
            stats.partialOverlaps += 1;
        const outputIndex = records.length;
        records.push(candidate);
        incrementByFile(stats, candidate, 1);
        active.push({ record: candidate, outputIndex });
    }
}
async function dedupeSourceRecords(inputs) {
    const byFamily = { v4: [], v6: [] };
    let input = 0;
    for await (const record of inputs) {
        input += 1;
        if (input > exports.DEDUPE_MAX_INPUT_ROWS) {
            throw new Error(`dedupe input exceeded DEDUPE_MAX_INPUT_ROWS=${exports.DEDUPE_MAX_INPUT_ROWS}; refusing to materialize the new-source ranges`);
        }
        byFamily[record.family].push(record);
    }
    const stats = {
        input,
        contained: 0,
        exactDuplicates: 0,
        partialOverlaps: 0,
        emitted: 0,
        emittedByFile: {},
    };
    const records = [];
    dedupeFamily(byFamily.v4, records, stats);
    dedupeFamily(byFamily.v6, records, stats);
    stats.emitted = records.length;
    return { records, stats };
}
//# sourceMappingURL=dedupe.js.map
// SPDX-License-Identifier: MIT
import { compareBuffers } from "../../ip";
import type { Source } from "../../types";
import type { EtlRunDownloadSource } from "../../storage/mysql";
import type { AddressFamily, SourceRecord } from "./types";

export const DEDUPE_MAX_INPUT_ROWS = 1_000_000;

export const DEDUPE_CONFLICT_PRIORITY: Readonly<
  Record<"sapics-user" | "runishiwo-cn" | "metowolf-cn", number>
> = {
  "sapics-user": 3,
  "runishiwo-cn": 2,
  "metowolf-cn": 1,
};

export interface DedupeStats {
  input: number;
  contained: number;
  exactDuplicates: number;
  partialOverlaps: number;
  emitted: number;
  emittedByFile: Partial<Record<EtlRunDownloadSource, number>>;
}

export interface DedupeResult {
  records: SourceRecord[];
  stats: DedupeStats;
}

interface Candidate {
  record: SourceRecord;
  outputIndex: number;
}

function priorityFor(source: Source): number {
  return DEDUPE_CONFLICT_PRIORITY[source as keyof typeof DEDUPE_CONFLICT_PRIORITY] ?? 0;
}

function sameRange(first: SourceRecord, second: SourceRecord): boolean {
  return (
    compareBuffers(first.startIp, second.startIp) === 0 &&
    compareBuffers(first.endIp, second.endIp) === 0
  );
}

function contains(outer: SourceRecord, inner: SourceRecord): boolean {
  return (
    compareBuffers(outer.startIp, inner.startIp) <= 0 &&
    compareBuffers(outer.endIp, inner.endIp) >= 0
  );
}

function sortByLargerRangeFirst(records: SourceRecord[]): void {
  records.sort((left, right) => {
    const byStart = compareBuffers(left.startIp, right.startIp);
    return byStart !== 0 ? byStart : compareBuffers(right.endIp, left.endIp);
  });
}

function incrementByFile(stats: DedupeStats, record: SourceRecord, delta: number): void {
  const current = stats.emittedByFile[record.etlSource] ?? 0;
  const next = current + delta;
  if (next === 0) {
    delete stats.emittedByFile[record.etlSource];
  } else {
    stats.emittedByFile[record.etlSource] = next;
  }
}

function replaceWithHigherPriority(
  records: SourceRecord[],
  active: Candidate[],
  stats: DedupeStats,
  existingIndex: number,
  candidate: SourceRecord,
): void {
  const previous = records[existingIndex]!;
  if (priorityFor(candidate.source) <= priorityFor(previous.source)) return;
  incrementByFile(stats, previous, -1);
  records[existingIndex] = candidate;
  incrementByFile(stats, candidate, 1);
  for (const item of active) {
    if (item.outputIndex === existingIndex) item.record = candidate;
  }
}

function dedupeFamily(
  familyRecords: SourceRecord[],
  records: SourceRecord[],
  stats: DedupeStats,
): void {
  sortByLargerRangeFirst(familyRecords);
  const active: Candidate[] = [];
  for (const candidate of familyRecords) {
    active.splice(
      0,
      active.length,
      ...active.filter((item) => compareBuffers(item.record.endIp, candidate.startIp) >= 0),
    );
    let coveredBy: Candidate | null = null;
    let exact: Candidate | null = null;
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
      if (
        compareBuffers(item.record.endIp, candidate.startIp) >= 0 &&
        compareBuffers(item.record.endIp, candidate.endIp) < 0
      ) {
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
    if (overlaps) stats.partialOverlaps += 1;
    const outputIndex = records.length;
    records.push(candidate);
    incrementByFile(stats, candidate, 1);
    active.push({ record: candidate, outputIndex });
  }
}

export async function dedupeSourceRecords(
  inputs: AsyncIterable<SourceRecord>,
): Promise<DedupeResult> {
  const byFamily: Record<AddressFamily, SourceRecord[]> = { v4: [], v6: [] };
  let input = 0;
  for await (const record of inputs) {
    input += 1;
    if (input > DEDUPE_MAX_INPUT_ROWS) {
      throw new Error(
        `dedupe input exceeded DEDUPE_MAX_INPUT_ROWS=${DEDUPE_MAX_INPUT_ROWS}; refusing to materialize the new-source ranges`,
      );
    }
    byFamily[record.family].push(record);
  }
  const stats: DedupeStats = {
    input,
    contained: 0,
    exactDuplicates: 0,
    partialOverlaps: 0,
    emitted: 0,
    emittedByFile: {},
  };
  const records: SourceRecord[] = [];
  dedupeFamily(byFamily.v4, records, stats);
  dedupeFamily(byFamily.v6, records, stats);
  stats.emitted = records.length;
  return { records, stats };
}

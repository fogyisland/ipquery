// SPDX-License-Identifier: MIT
import type { NormalizedRecord } from "../../types";
import type { EtlRunDownloadSource } from "../../storage/mysql";

export type AddressFamily = "v4" | "v6";

export interface SourceRecord extends NormalizedRecord {
  etlSource: EtlRunDownloadSource;
  family: AddressFamily;
}

export interface ParseSkipCounters {
  shortLine: number;
  headerRow: number;
  unparseableIp: number;
  missingCol: number;
  nonNumericAsn: number;
  other: number;
}

export interface ParseStats {
  rowsEmitted: number;
  skipped: ParseSkipCounters;
  gunzipErrors: number;
}

export interface ParseStreamResult<T extends NormalizedRecord = NormalizedRecord> {
  records: AsyncIterable<T>;
  stats: ParseStats;
}

export function newStats(): ParseStats {
  return {
    rowsEmitted: 0,
    skipped: {
      shortLine: 0,
      headerRow: 0,
      unparseableIp: 0,
      missingCol: 0,
      nonNumericAsn: 0,
      other: 0,
    },
    gunzipErrors: 0,
  };
}

export interface CidrRange {
  startIp: Buffer;
  endIp: Buffer;
  countryCode: string;
  family: AddressFamily;
}

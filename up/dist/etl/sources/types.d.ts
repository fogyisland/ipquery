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
export declare function newStats(): ParseStats;
export interface CidrRange {
    startIp: Buffer;
    endIp: Buffer;
    countryCode: string;
    family: AddressFamily;
}

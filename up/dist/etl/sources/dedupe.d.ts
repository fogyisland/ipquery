import type { EtlRunDownloadSource } from "../../storage/mysql";
import type { SourceRecord } from "./types";
export declare const DEDUPE_MAX_INPUT_ROWS = 1000000;
export declare const DEDUPE_CONFLICT_PRIORITY: Readonly<Record<"sapics-user" | "runishiwo-cn" | "metowolf-cn", number>>;
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
export declare function dedupeSourceRecords(inputs: AsyncIterable<SourceRecord>): Promise<DedupeResult>;

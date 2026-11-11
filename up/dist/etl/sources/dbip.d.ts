import type { NormalizedRecord } from "../../types";
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
export interface ParseStreamResult {
    records: AsyncIterable<NormalizedRecord>;
    stats: ParseStats;
}
export declare function parseDbipCityCsvStream(gzPath: string): AsyncIterable<NormalizedRecord>;
export declare function parseDbipCityCsv(gzPath: string): Promise<NormalizedRecord[]>;
export declare function parseDbipCityCsvStreamWithStats(gzPath: string): ParseStreamResult;
export declare function parseDbipCountryCsvStream(gzPath: string): AsyncIterable<NormalizedRecord>;
export declare function parseDbipCountryCsv(gzPath: string): Promise<NormalizedRecord[]>;
export declare function parseDbipCountryCsvStreamWithStats(gzPath: string): ParseStreamResult;
export declare function parseDbipAsnCsvStream(gzPath: string): AsyncIterable<NormalizedRecord>;
export declare function parseDbipAsnCsv(gzPath: string): Promise<NormalizedRecord[]>;
export declare function parseDbipAsnCsvStreamWithStats(gzPath: string): ParseStreamResult;
export declare const parseDbipCsv: typeof parseDbipCityCsv;
export declare const parseDbipCsvStream: typeof parseDbipCityCsvStream;

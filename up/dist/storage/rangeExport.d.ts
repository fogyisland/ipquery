import type { Pool } from "mysql2/promise";
export interface ExportFilter {
    /** Restrict to one ISO country code. */
    readonly countryCode?: string;
    /** Called with the running total as rows are written, so the console can
     *  show a bar instead of a spinner. */
    readonly onProgress?: (written: number, total: number) => void;
}
export interface ExportResult {
    readonly rows: number;
    readonly bytes: number;
    readonly path: string;
}
/**
 * Write every matching range to `filePath` as an .ipq file.
 *
 * The file is written to a temporary name and renamed on completion, so a
 * failed export never leaves a half-written file that looks downloadable.
 */
export declare function exportRangesToFile(pool: Pool, filePath: string, filter?: ExportFilter): Promise<ExportResult>;

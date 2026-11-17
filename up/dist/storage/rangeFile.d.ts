export declare const IPQ_FORMAT = "ipquery-ranges";
export declare const IPQ_VERSION = 1;
/** The most a single import reads, unless the caller says otherwise. */
export declare const IPQ_DEFAULT_MAX_ROWS = 1000000;
export interface RangeFileHeader {
    readonly format: string;
    readonly version: number;
    readonly exportedAt: string;
    readonly rows: number;
}
/** One range, as text. The addresses stay textual all the way through the
 *  file: a BINARY(16) column cannot tell an operator which row is wrong. */
export interface RangeRecord {
    /** 1-based line this record came from. 0 for one built in memory (the
     *  exporter). Reported with a write failure so the operator can open the
     *  file at the right place. */
    readonly line: number;
    readonly start: string;
    readonly end: string;
    readonly countryCode: string | null;
    readonly countryName: string | null;
    readonly region: string | null;
    readonly city: string | null;
    readonly postalCode: string | null;
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly timezone: string | null;
    readonly isp: string | null;
    readonly asn: number | null;
    readonly asnOrg: string | null;
}
/** The row shape the exporter hands over. Field names are the database's,
 *  camelCased; `encodeRange` is the only place that knows the file's own
 *  spelling. */
export type RangeRow = RangeRecord;
/** A file that cannot be imported. The message names the line, because the
 *  operator is holding the file and has nothing else to go on. */
export declare class RangeFileError extends Error {
    constructor(message: string);
}
export declare function encodeHeader(meta: {
    exportedAt: string;
    rows: number;
}): string;
export declare function encodeRange(row: RangeRow): string;
export interface DecodeOptions {
    /** Rows past this many stop the import. Defaults to the import ceiling. */
    readonly maxRows?: number;
}
export interface DecodedRangeFile {
    readonly header: RangeFileHeader;
    readonly ranges: readonly RangeRecord[];
}
/**
 * Read a whole .ipq file held in memory.
 *
 * The streaming path (`readRangeFileStream`) is what the route uses for an
 * upload; this one exists for the parts that are easier to state as data —
 * a pasted snippet, a fixture, and every test of the format itself.
 */
export declare function decodeFile(text: string, options?: DecodeOptions): DecodedRangeFile;
export interface StreamOptions {
    readonly maxRows?: number;
    /** Rows handed to `onBatch` at a time. One INSERT per row is what makes a
     *  nine-million-row import take hours. */
    readonly batchSize?: number;
    /** Called once, before the first batch, with the parsed header. A refusal
     *  belongs here: nothing should be written into a staging table for a file
     *  this build cannot read. */
    readonly onHeader: (header: RangeFileHeader) => void | Promise<void>;
    readonly onBatch: (rows: readonly RangeRecord[]) => Promise<void>;
}
/**
 * Read a .ipq file straight from a stream.
 *
 * The file is line-delimited, so the reader only has to hold the line it is
 * in the middle of: memory is bounded by the longest line, not by the file.
 * A whole-library export is around two gigabytes, which is more than a
 * String can hold once, so reading it as text and splitting afterwards is
 * not an option.
 *
 * A partial line at the end of a chunk is carried into the next one. Getting
 * that wrong is the difference between "works" and "loses a row every 64 KB
 * depending on where the socket happened to split".
 */
export declare function decodeStream(input: AsyncIterable<Buffer | string>, options: StreamOptions): Promise<void>;

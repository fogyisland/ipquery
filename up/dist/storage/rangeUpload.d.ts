import type { Pool } from "mysql2/promise";
/** An upload that cannot continue. The message says which part is wrong:
 *  an offset past the end and a missing upload are different problems to
 *  the person looking at the browser console. */
export declare class UploadError extends Error {
    constructor(message: string);
}
export interface ReservedUpload {
    readonly id: number;
    readonly mode: "merge" | "replace";
    readonly filename: string;
    readonly totalBytes: number;
    /** Where the assembled bytes live. The name is generated, never supplied
     *  by the caller — an upload id is not a path. */
    readonly filepath: string;
}
export interface UploadState extends ReservedUpload {
    readonly receivedBytes: number;
    /** Where the next missing byte is. The browser sends from here. */
    readonly nextOffset: number;
    readonly complete: boolean;
}
/** Chunk size the browser sends. Small enough to retry cheaply, large
 *  enough that a two-gigabyte file is not a hundred thousand requests. */
export declare const UPLOAD_CHUNK_BYTES: number;
/** Nothing may be uploaded larger than this. Two gigabytes covers a
 *  whole-library .ipq with room for the fields that make it readable. */
export declare const UPLOAD_MAX_BYTES: number;
/**
 * How long an upload may sit unfinished before it is treated as
 * abandoned.
 *
 * Two days is a judgement, not a measurement. The upload is abandoned
 * when the operator will not come back for it: the tab closed, the
 * laptop slept, the transfer died halfway. Two days is long enough that
 * somebody who came back on Monday still finds their upload on Saturday,
 * and short enough that the disk is not filling with two-gigabyte files
 * that nobody will ever import.
 */
export declare const UPLOAD_ABANDONED_AFTER_HOURS = 48;
/**
 * Throw away the uploads nobody came back for.
 *
 * An upload that was started and never finished is dead weight: the rows
 * that describe it, the row for every chunk that landed, and — the real
 * cost — the assembled file on disk, which for a whole-library upload is
 * two gigabytes. Nothing about it will ever be used.
 *
 * Only unfinished uploads are swept. One that is `ready` is waiting to be
 * imported and the operator may still press the button; one that is
 * `importing` is being read right now.
 *
 * The files go too. A file left on disk is a file somebody has to sweep
 * by hand, and the whole point of this is that the install does not make
 * the operator do that.
 *
 * Returns the number of uploads removed.
 */
export declare function purgeAbandonedUploads(pool: Pool): Promise<number>;
/**
 * Put a file that arrived in one piece on disk, ready to be imported.
 *
 * The small-file path gets the text as a form field, so it is already in
 * memory — but the import runs detached, and a detached job cannot read
 * the request's memory. The file has to be on disk for the job to find.
 *
 * The name is generated, never taken from the upload, and it lands in the
 * same directory the chunked path uses so the importer has one place to
 * look. The caller removes it when the job ends.
 */
export declare function stageImportFile(text: string): Promise<string>;
export declare function reserveUpload(pool: Pool, fields: {
    mode: "merge" | "replace";
    filename: string;
    totalBytes: number;
}): Promise<ReservedUpload>;
/**
 * Write one chunk at `offset`.
 *
 * Repeating a chunk is harmless: the bytes are written to the same place
 * and the received ranges are recomputed from what is on record, so a retry
 * after a lost acknowledgement does not corrupt the file.
 */
export declare function storeChunk(pool: Pool, id: number, offset: number, data: Buffer | string): Promise<void>;
/** Mark an upload as finished. Called when the browser says it has sent
 *  every byte, so a later reader does not have to decide for itself
 *  whether a short file is a partial upload or a complete one. */
export declare function finishUpload(pool: Pool, id: number): Promise<void>;
export interface OpenUpload extends UploadState {
    /** The assembled file, read as a stream. Only complete uploads have one
     *  worth reading. */
    [Symbol.asyncIterator](): AsyncIterator<Buffer>;
}
/**
 * The upload's state, and — when it is complete — a stream of its bytes.
 *
 * Read from disk rather than held: a two-gigabyte file is not something to
 * have as a string, and the importer wants it a line at a time anyway.
 */
export declare function openUpload(pool: Pool, id: number): Promise<OpenUpload>;
/**
 * Throw an upload away: the file on disk, the row that described it, and
 * the row for every chunk that was sent.
 *
 * The import is the inverse of the export, and nothing about an uploaded
 * file needs to outlive it. The chunk rows matter as much as the file: one
 * per chunk means a two-gigabyte upload leaves a hundred and twenty-eight
 * of them, and a year of imports is a table nobody reads and nobody dares
 * delete.
 *
 * Doing this twice is not an error — the import path discards the upload
 * and so does the sweep that clears abandoned ones.
 */
export declare function discardUpload(pool: Pool, id: number): Promise<void>;

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

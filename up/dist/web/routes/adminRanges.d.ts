import type { FastifyInstance } from "fastify";
/**
 * The largest body these routes will parse.
 *
 * Fastify's default is 1 MB and `@fastify/formbody` inherits it. A .ipq
 * export of a few thousand ranges is already several megabytes, so the
 * default rejected the file the page itself produces — and it rejected it
 * from inside a pre-parsing hook, which resets the socket instead of
 * answering 413. The operator saw "connection reset" with no explanation.
 *
 * 512 MB is the ceiling for a whole-library file. It is a limit on the
 * request body, not on the import: `importRanges` and the streaming reader
 * keep their own bounds.
 */
export declare const RANGE_BODY_LIMIT: number;
export interface RangeExportState {
    readonly id: string;
    readonly file: string;
    readonly rows: number;
    readonly bytes: number;
    readonly createdAt: number;
}
/** Async because Fastify treats a plugin that returns nothing as
 *  "forgot to call done" — `register` needs a promise to await. */
export declare function registerRangeRoutes(app: FastifyInstance): Promise<void>;

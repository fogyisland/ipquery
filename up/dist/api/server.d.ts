import { type FastifyInstance } from "fastify";
import type { AppConfig } from "../config";
import { createPool } from "../storage/mysql";
import { createMailer } from "../mailer";
declare module "fastify" {
    interface FastifyInstance {
        cfg: AppConfig;
        pool: ReturnType<typeof createPool>;
        mailer: ReturnType<typeof createMailer>;
        resetLoginLimit: () => void;
        flushQueryLog: () => Promise<void>;
        randomGenRunner: {
            tickNow: () => Promise<void>;
            syncFromSettings: () => Promise<boolean>;
        };
    }
}
/**
 * Strip the `key` query parameter from a URL before it is logged.
 *
 * `/lookup` accepts an API key as a query parameter for backwards
 * compatibility, but a key in the URL lands in the access log, in any
 * reverse proxy's log, in browser history and in the Referer header of
 * every outbound link from the page. A key in the log is a key in
 * someone's hands.
 *
 * The query-parameter form is kept working (removing it would break
 * existing API clients) but it is scrubbed on the way into the log, so
 * the operator's logs hold the path without the secret.
 */
export declare function redactKeyParam(url: string): string;
export declare function buildServer(cfg: AppConfig, opts?: {
    extraRoutes?: (app: FastifyInstance) => Promise<void> | void;
}): Promise<FastifyInstance>;

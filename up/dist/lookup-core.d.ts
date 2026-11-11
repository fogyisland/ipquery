import type { Pool } from "mysql2/promise";
import type { LookupResult } from "./types";
/** Minimal logger surface doLookupCore needs (satisfied by fastify's logger). */
export interface CoreLogger {
    warn: (obj: unknown, msg: string) => void;
}
export declare function doLookupCore(pool: Pool, log: CoreLogger, ip: string): Promise<LookupResult>;

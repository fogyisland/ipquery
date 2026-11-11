import type { Pool } from "mysql2/promise";
import type { QueryLogEntry } from "../types";
export interface QueryLogInsertable {
    ip: Buffer;
    ipText: string;
    status: "hit" | "miss" | "invalid";
    userId: number | null;
    apiKeyId: number | null;
    sessionId: string | null;
    remoteAddr: Buffer | null;
    userAgent: string | null;
}
export declare function insertQueryLogs(pool: Pool, entries: QueryLogInsertable[]): Promise<void>;
export interface QueryLogQuery {
    offset: number;
    limit: number;
    userId?: number;
    status?: "hit" | "miss" | "invalid";
    ipText?: string;
    startTime?: Date;
    endTime?: Date;
    sort?: {
        col: "id" | "ts";
        dir: "asc" | "desc";
    };
}
export interface QueryLogRow extends QueryLogEntry {
    id: number;
    userEmail?: string | null;
    apiKeyPrefix?: string | null;
}
export declare function listQueryLogs(pool: Pool, q: QueryLogQuery): Promise<{
    rows: QueryLogRow[];
    total: number;
}>;
export declare function countQueriesByStatusSince(pool: Pool, since: Date, opts?: {
    userId?: number;
}): Promise<{
    hit: number;
    miss: number;
    invalid: number;
}>;
export interface DailyBucket {
    date: string;
    hit: number;
    miss: number;
    invalid: number;
    total: number;
}
export interface LastQuery {
    ipText: string;
    status: "hit" | "miss" | "invalid";
    ts: Date;
    countryCode: string | null;
    countryName: string | null;
    asnOrg: string | null;
}
export declare function getLastUserQuery(pool: Pool, userId: number): Promise<LastQuery | null>;
export declare function countQueriesByDay(pool: Pool, days: number): Promise<DailyBucket[]>;
export declare function streamQueryLogsCsv(pool: Pool, q: QueryLogQuery, write: (chunk: string) => void): Promise<void>;

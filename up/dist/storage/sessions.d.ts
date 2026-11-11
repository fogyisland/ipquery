import type { Pool } from "mysql2/promise";
import type { Session } from "../types";
export declare function createSession(pool: Pool, id: string, userId: number, expiresAt: Date): Promise<Session>;
export declare function loadSession(pool: Pool, id: string): Promise<Session | null>;
export declare function destroySession(pool: Pool, id: string): Promise<void>;
export declare function destroyAllForUser(pool: Pool, userId: number): Promise<void>;
export declare function destroyAllForUserExcept(pool: Pool, userId: number, keepSid: string): Promise<number>;
export declare function purgeExpired(pool: Pool): Promise<number>;
